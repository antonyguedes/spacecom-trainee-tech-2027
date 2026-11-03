## Como rodar

Coloque os `dataset*.txt` na raiz do projeto e execute (testado no Node 24.19):

```bash
node src/index.js                      # todos os dataset*.txt do diretório atual
node src/index.js dataset6.txt         # um ou mais arquivos específicos
node scripts/validar.js                # confere output/ com os gabaritos respostas*.json
CPUS=0-15 bash scripts/bench.sh 30     # 30 repetições por dataset, fixando os núcleos
```

O resultado vai para `output/<dataset>.json`. Os arquivos gerados para os 7 datasets já estão nessa pasta.

## Lógica

1. **Fila de trechos (work stealing):** arquivos grandes são processados por `worker_threads`, que pegam trechos de 1 MB de uma fila, um por vez, usando um contador atômico compartilhado (`Atomics.add`). Quem termina antes pega o próximo, então os núcleos mais rápidos fazem mais trabalho. Cada trecho é lido em um buffer reaproveitado, e o parse e a detecção acontecem nele.
   - **Sem pares divididos:** cada trecho começa na primeira troca de timestamp depois do seu início e termina na primeira troca depois do seu fim. Essa fronteira depende só dos bytes do arquivo, então trechos vizinhos chegam ao mesmo ponto: nenhuma linha se perde ou se repete, e todo timestamp fica inteiro em um trecho.
2. **Leitura:** os bytes são analisados diretamente, sem criar uma string por linha, e as linhas ficam em colunas (`Int32Array`/`Float64Array`) agrupadas por timestamp.
3. **Linhas inválidas:** são descartadas as linhas vazias, o cabeçalho e as que não têm `id`, `latitude` e `longitude` numéricos seguidos do `;` da 6ª coluna.
4. **Detecção:** cada ponto entra em um grid 1D por latitude, com células de 0,0002°. Como 20 m equivalem a cerca de 0,00018°, um par válido sempre está na mesma célula ou na vizinha. Só esses candidatos passam pelo Haversine, com `R = 6371000` m, exigindo `d < 20`.
5. **Classificação:** `protetiva` (a linha de um dos dois é a da vítima e `idsRestricaoMedida` lista o outro como agressor) > `faccao` (mesma facção, não vazia) > `generico`. Há um único registro por par em cada timestamp. Nos dados, vítimas não têm facção, então nenhum par se encaixa em `protetiva` e `faccao` ao mesmo tempo.
6. **Saída:** ordenada por timestamp e par, com os campos `tipo, monitoradosEncontro, timestamp, posicoes, distanciaMetros`.

**Arquivos fora de ordem:** os datasets estão ordenados, mas o programa não depende disso. Cada trecho informa o menor e o maior timestamp que leu. Se as faixas se sobrepõem, ou se um timestamp é grande demais para achar a fronteira na janela de 256 KB, a divisão não é confiável e o arquivo é reprocessado inteiro em uma thread. IDs repetidos no mesmo timestamp são descartados: vale a primeira ocorrência.

## Resultados

| Dataset | Tamanho | Linhas | Timestamps | Máx. por timestamp | Pares possíveis | Encontros | protetiva | faccao | generico |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 (teste) | 0,3 MB | 5.000 | 500 | 10 | 22,5 mil | 4 | 1 | 1 | 2 |
| 2 (teste) | 1,3 MB | 25.000 | 1.250 | 20 | 237,5 mil | 6 | 1 | 2 | 3 |
| 3 | 5,3 MB | 100.000 | 2.500 | 40 | 1,95 M | 10 | 2 | 3 | 5 |
| 4 | 21 MB | 400.020 | 6.667 | 60 | 11,8 M | 15 | 3 | 5 | 7 |
| 5 | 53 MB | 1.000.000 | 12.500 | 80 | 39,5 M | 21 | 4 | 7 | 10 |
| 6 | 423 MB | 8.000.000 | 80.000 | 100 | 396 M | 27 | 6 | 9 | 12 |
| 7 | 638 MB | 12.000.000 | 100.000 | 120 | 714 M | 35 | 8 | 12 | 15 |

Os datasets oficiais (3 a 7) somam **108 encontros**.

### Validação

- **Gabaritos (datasets 1 e 2):** TP 10, FP 0, FN 0. Tipo, par, timestamp, posições e ordem coincidem, e as 10 distâncias são idênticas bit a bit.
- **Datasets 3 a 7:** não têm gabarito. Uma força bruta escrita à parte em Python, sem reaproveitar código da solução, chega exatamente aos mesmos pares, timestamps e tipos. Ela parte da mesma leitura das regras do enunciado.
- **Margem no limite de 20 m:** o par mais próximo acima do limite está a 20,73 m, então a regra de `d < 20` não depende de arredondamento.
- **Corte dos trechos:** o resultado foi comparado com o processamento em uma thread em 50 combinações de arquivo, workers e tamanho de trecho, sem nenhuma divergência. Elas incluem trechos minúsculos, arquivos truncados, linhas inválidas no meio do arquivo, arquivo embaralhado e blocos invertidos. Em um timestamp maior que a janela, com pares plantados no início, no meio e no fim, todos foram encontrados.
- **Estabilidade:** 833 execuções seguidas dos datasets 4 a 7, sem erro nem travamento.
- **Outros casos testados:** CRLF, IDs repetidos, listas com vários agressores e execução com 1, 2 e 4 CPUs.

## Desempenho

O desempate do desafio é a soma do tempo médio de execução por dataset, sem definir se a partida do runtime entra na conta. Por isso as duas formas foram medidas: o **processo completo** e **só o algoritmo** (leitura, detecção e gravação, cronometrados dentro do processo).

Médias em ms, com 30 repetições intercaladas em ordem aleatória, sem fixar núcleos, em um i9-14900HX (32 threads) com Node 24.19:

| Medida | Execução | D1 | D2 | D3 | D4 | D5 | D6 | D7 | Soma |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Processo | **Versão final (fila de trechos)** | 37,0 | 39,4 | 56,9 | 86,9 | 103,6 | 247,3 | 309,5 | **881** |
| | Workers com partes fixas | 35,5 | 39,2 | 59,2 | 98,9 | 116,3 | 298,5 | 401,2 | 1.049 |
| | Sem workers | 35,4 | 42,1 | 56,4 | 97,9 | 163,0 | 931,1 | 1.352,5 | 2.679 |
| Algoritmo | **Versão final (fila de trechos)** | 7,0 | 14,6 | 31,4 | 58,4 | 77,6 | 213,3 | 276,3 | **679** |
| | Workers com partes fixas | 6,9 | 14,4 | 31,5 | 68,9 | 88,6 | 269,4 | 371,9 | 851 |
| | Sem workers | 7,5 | 16,0 | 30,0 | 73,2 | 139,8 | 904,9 | 1.324,1 | 2.495 |

Em "Workers com partes fixas", cada worker recebe uma fatia pré-definida do arquivo, em vez de pegar trechos de uma fila. Fixando os núcleos P, a versão final soma 955 ms.

### Decisões, com o que foi medido

- **JavaScript em vez de TypeScript:** rodar `.ts` no Node carrega o removedor de tipos em cada worker. Nas medições com workers, isso custou de 18% (2 workers) a 38% (8 workers) na soma. Os tipos estão documentados em JSDoc.
- **`worker_threads` por tamanho de arquivo:** reduzem a soma em 67%. Abaixo de 16 MB, 1 thread; até 128 MB, 4 workers; acima disso, 12. A quantidade nunca passa do número de núcleos disponíveis.
- **Fila de trechos em vez de partes fixas:** com partes fixas, o worker mais lento segura todos, e esta CPU mistura núcleos rápidos (P) e lentos (E). A fila reduz a soma em 16%. Só nos núcleos P, que são parecidos entre si, o ganho cai para 6%, porque boa parte vem de balancear núcleos diferentes.
- **Parser em bytes e grid:** em uma amostra de 692 mil linhas do dataset 6, o parser reduziu o parse de cerca de 240 ms para 77 ms e o grid reduziu a detecção de cerca de 43 ms para 11 ms, em relação ao `split` e à comparação linear com pré-filtro.
- **Trechos de 1 MB:** entre 0,5, 1 e 2 MB, 1 MB teve a melhor soma nos datasets 6 e 7, com 12 workers, embora as diferenças para vizinhos como 2 MB estejam perto do ruído. Reaproveitar o buffer também evita que cada worker aloque uma fatia grande do arquivo.

### Técnicas testadas e descartadas

| Técnica | Resultado |
|---|---|
| Thread principal também processando a fila | Sem ganho claro e travou ocasionalmente ao encerrar o processo (causa não identificada) |
| Latitude como inteiro, sem divisão por linha | Dentro do ruído |
| Longitude convertida só nos pares candidatos | Dentro do ruído |
| Compile cache do Node (`NODE_COMPILE_CACHE`) | Sem ganho |
| Flag `--always-sparkplug` do V8 | Piora |
| 20 ou 24 workers | Piora |


**Limitações das medições:** os números valem para esta máquina e só são comparáveis dentro da mesma rodada. O `bench.sh` também conta o custo do shell. Com menos núcleos o ganho diminui: no dataset 7, o algoritmo levou cerca de 0,2 a 0,3 s com todos os núcleos, 0,6 s com 4 CPUs, 1,1 s com 2 e 1,3 s com 1. Em uma CPU sem núcleos híbridos, a vantagem da fila sobre as partes fixas tende a ser pequena.

## Por que esta abordagem

- **Exatidão primeiro:** o Score depende de acertar os encontros, então a detecção segue o enunciado à risca e foi conferida pelos gabaritos e por uma força bruta independente sobre os dados completos.
- **Otimização onde o tempo realmente vai:** o custo está em processar milhões de linhas, e não em calcular distâncias, porque quase nenhum par chega perto de 20 m. Por isso o parser em bytes, o grid e a fila de trechos concentram o ganho. A fila aproveita todos os núcleos disponíveis sem depender de eles terem a mesma velocidade.
- **Sem custo escondido:** não há dependências nem build, e a regra de workers evita pagar por paralelismo em arquivos pequenos. Cada otimização adotada tem um ganho medido acima, e as que não o tiveram ficaram de fora.
- **Segurança antes da velocidade:** se a divisão em trechos não for confiável, o programa volta para o processamento em uma thread em vez de arriscar um resultado errado.
