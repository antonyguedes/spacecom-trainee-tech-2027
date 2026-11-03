// Confere output/dataset*.json: compara com os gabaritos respostas{n}.json quando existem
// e checa a sanidade de todos (distância < 20 m, ordem do par, chaves únicas).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ler = (caminho) => JSON.parse(readFileSync(caminho, 'utf8'));
const chave = (e) =>
  `${e.tipo}|${e.monitoradosEncontro[0]}|${e.monitoradosEncontro[1]}|${e.timestamp}`;

let falhou = false;
const saidas = readdirSync('output')
  .filter((nome) => /^dataset.*\.json$/.test(nome))
  .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));

if (saidas.length === 0) {
  console.error('Nenhum output/dataset*.json. Rode antes: node src/index.js');
  process.exit(1);
}

for (const nome of saidas) {
  const encontros = ler(join('output', nome));
  const problemas = [];
  const chaves = new Set(encontros.map(chave));
  if (chaves.size !== encontros.length) problemas.push('chaves duplicadas');
  for (const e of encontros) {
    const [a, b] = e.monitoradosEncontro;
    if (!(e.distanciaMetros < 20)) problemas.push(`distância ${e.distanciaMetros} em ${chave(e)}`);
    if (!(a < b)) problemas.push(`par fora de ordem em ${chave(e)}`);
    if (!e.posicoes[a] || !e.posicoes[b]) problemas.push(`posição ausente em ${chave(e)}`);
  }

  const contagem = { protetiva: 0, faccao: 0, generico: 0 };
  for (const e of encontros) contagem[e.tipo]++;
  let linha = `${nome}: ${encontros.length} encontros (protetiva ${contagem.protetiva}, faccao ${contagem.faccao}, generico ${contagem.generico})`;

  const gabarito = `respostas${nome.match(/\d+/)?.[0]}.json`;
  if (existsSync(gabarito)) {
    const esperados = new Map(ler(gabarito).map((e) => [chave(e), e]));
    let tp = 0;
    let fp = 0;
    let identicas = 0;
    let deltaMax = 0;
    for (const e of encontros) {
      const r = esperados.get(chave(e));
      if (!r) {
        fp++;
        problemas.push(`não está no gabarito: ${chave(e)}`);
        continue;
      }
      tp++;
      if (JSON.stringify(e.posicoes) !== JSON.stringify(r.posicoes)) {
        problemas.push(`posições diferentes em ${chave(e)}`);
      }
      if (e.distanciaMetros === r.distanciaMetros) identicas++;
      deltaMax = Math.max(deltaMax, Math.abs(e.distanciaMetros - r.distanciaMetros));
    }
    const fn = esperados.size - tp;
    if (fn > 0) problemas.push(`${fn} encontros do gabarito não detectados`);
    linha += ` | ${gabarito}: TP ${tp}, FP ${fp}, FN ${fn}, distâncias idênticas ${identicas}/${tp}, Δmáx ${deltaMax.toExponential(2)} m`;
  }

  console.log(linha);
  for (const p of problemas) console.log(` ✗ ${p}`);
  if (problemas.length > 0) falhou = true;
}

process.exit(falhou ? 1 : 0);
