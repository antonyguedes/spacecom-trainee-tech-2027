// Detecção de encontros entre monitorados: pares a menos de 20 m no mesmo timestamp.
// Uso: node src/index.js [arquivos…]   (sem argumentos, processa os dataset*.txt do diretório atual)
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, extname, join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const DISTANCIA_MAX = 20;
const RAIO_TERRA = 6371000;
// 20 m equivalem a ~0,00018° de latitude: nenhum par válido fica de fora deste limiar
const LIMIAR_LAT = 0.0002;
const MASCARA_GRID = 1023;
// Workers por tamanho de arquivo, conforme medido: em arquivos pequenos, iniciá-los custa
// mais do que economiza, e acima de 12 a paralelização deixa de compensar
const FAIXAS_WORKERS = [
  { ateBytes: 16 * 1024 * 1024, workers: 1 },
  { ateBytes: 128 * 1024 * 1024, workers: 4 },
  { ateBytes: Infinity, workers: 12 },
];
// Os workers pegam trechos do arquivo de uma fila. A janela extra permite achar, depois do
// fim do trecho, a troca de timestamp onde ele realmente termina.
const BYTES_TRECHO = 1024 * 1024;
const BYTES_JANELA = 256 * 1024;

const LF = 10;
const ASPAS_CR = /["\r]/g;
const PONTO_E_VIRGULA = 59;
const MENOS = 45;
const PONTO = 46;
const ZERO = 48;
const NOVE = 57;

/**
 * @typedef {object} Encontro
 * @property {'protetiva' | 'faccao' | 'generico'} tipo
 * @property {[number, number]} monitoradosEncontro
 * @property {string} timestamp
 * @property {Record<number, { lat: number, lon: number }>} posicoes
 * @property {number} distanciaMetros
 *
 * Colunas das linhas válidas; cada grupo é uma faixa contígua [inicios[g], inicios[g + 1]).
 * @typedef {object} Tabela
 * @property {Int32Array} ids
 * @property {Float64Array} lats
 * @property {Float64Array} lons
 * @property {string[]} timestamps
 * @property {number[]} inicios
 * @property {number} total
 * @property {(string | null | undefined)[]} faccao
 * @property {Map<number, Set<number>>} agressoresDe vítima → agressores
 */

// Colunas e registro de pessoas reaproveitados entre os trechos de um mesmo arquivo:
// um estado por thread e por arquivo, nunca compartilhado.
const novoEstado = () => ({
  ids: new Int32Array(0),
  lats: new Float64Array(0),
  lons: new Float64Array(0),
  proximo: new Int32Array(0),
  celula: new Int32Array(0),
  faccao: [],
  agressoresDe: new Map(),
});

const toRad = (x) => (x * Math.PI) / 180;

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * RAIO_TERRA * Math.asin(Math.sqrt(a));
}

const POTENCIAS_10 = new Float64Array(16);
for (let k = 0; k < 16; k++) POTENCIAS_10[k] = 10 ** k;

function texto(b, ini, fim) {
  let s = '';
  for (let k = ini; k < fim; k++) s += String.fromCharCode(b[k]);
  return s;
}

function fimDaLinha(b, p, n) {
  while (p < n && b[p] !== LF) p++;
  return p + 1;
}

// Caminhos raros ficam fora de carregar(): manter o laço quente pequeno ajuda o JIT
function registrar(
  faccao,
  agressoresDe,
  id,
  fac,
  restricoes,
) {
  const nome = fac.replace(ASPAS_CR, '');
  faccao[id] = nome === '' ? null : nome;
  // idsRestricaoMedida lista os agressores da pessoa desta linha, que é a vítima
  const lista = restricoes.replace(ASPAS_CR, '');
  if (lista === '') return;
  agressoresDe.set(id, new Set(lista.split(',').map(Number)));
}

function abrirGrupo(
  ts,
  timestamps,
  inicios,
  grupoDoTimestamp,
  total,
) {
  const grupo = timestamps.length;
  grupoDoTimestamp.set(ts, grupo);
  timestamps.push(ts);
  inicios.push(total);
  return grupo;
}

function crescerInt32(a, capacidade) {
  const novo = new Int32Array(capacidade);
  novo.set(a);
  return novo;
}

function crescerFloat64(a, capacidade) {
  const novo = new Float64Array(capacidade);
  novo.set(a);
  return novo;
}

// Lê os bytes direto, sem criar uma string por linha. Linhas incompletas são descartadas:
// exigir o ';' depois da longitude evita aceitar uma coordenada truncada.
function carregar(b, estado) {
  const n = b.length;
  // As linhas reais têm 50 bytes ou mais; se a estimativa falhar, as colunas crescem
  let capacidade = estado.ids.length;
  if (capacidade < Math.floor(n / 30) + 1) {
    capacidade = Math.floor(n / 30) + 1;
    estado.ids = new Int32Array(capacidade);
    estado.lats = new Float64Array(capacidade);
    estado.lons = new Float64Array(capacidade);
  }
  let { ids, lats, lons } = estado;
  const timestamps = [];
  const inicios = [];
  // Cada troca de timestamp abre um trecho; só arquivos fora de ordem precisam deles
  const trechoGrupo = [];
  const trechoInicio = [];
  const grupoDoTimestamp = new Map();
  const ultimoGrupoDe = [];
  const { faccao, agressoresDe } = estado;

  let total = 0;
  let foraDeOrdem = false;
  let tsIni = -1;
  let tsTam = 0;
  let grupo = -1;
  let i = 0;

  linhas: while (i < n) {
    let p = i;
    let ch = 0;

    let id = 0;
    while (p < n && (ch = b[p]) >= ZERO && ch <= NOVE) {
      id = id * 10 + ch - ZERO;
      p++;
    }
    // no máximo 9 dígitos, para caber no Int32Array
    if (p === i || p - i > 9 || p >= n || ch !== PONTO_E_VIRGULA) {
      i = fimDaLinha(b, p, n);
      continue;
    }
    p++;

    const facIni = p;
    while (p < n && (ch = b[p]) !== PONTO_E_VIRGULA && ch !== LF) p++;
    if (p >= n || ch !== PONTO_E_VIRGULA) {
      i = fimDaLinha(b, p, n);
      continue;
    }
    const facFim = p++;

    const tIni = p;
    while (p < n && (ch = b[p]) !== PONTO_E_VIRGULA && ch !== LF) p++;
    if (p >= n || ch !== PONTO_E_VIRGULA || p === tIni) {
      i = fimDaLinha(b, p, n);
      continue;
    }
    const tFim = p++;

    let lat = 0;
    let lon = 0;
    for (let coluna = 0; coluna < 2; coluna++) {
      const ini = p;
      const negativo = p < n && b[p] === MENOS;
      if (negativo) p++;
      let mantissa = 0;
      let decimais = -1;
      let digitos = 0;
      for (; p < n; p++) {
        ch = b[p];
        if (ch >= ZERO && ch <= NOVE) {
          mantissa = mantissa * 10 + ch - ZERO;
          digitos++;
          if (decimais >= 0) decimais++;
        } else if (ch === PONTO && decimais < 0) {
          decimais = 0;
        } else break;
      }
      if (digitos === 0 || p >= n || ch !== PONTO_E_VIRGULA) {
        i = fimDaLinha(b, p, n);
        continue linhas;
      }
      // Até 15 dígitos, mantissa e potência são exatas no double e a divisão dá
      // o mesmo valor corretamente arredondado que Number() daria.
      let valor;
      if (digitos <= 15) {
        valor = decimais > 0 ? mantissa / POTENCIAS_10[decimais] : mantissa;
        if (negativo) valor = -valor;
      } else {
        valor = Number(texto(b, ini, p));
      }
      if (coluna === 0) lat = valor;
      else lon = valor;
      p++;
    }

    const medidaIni = p;
    while (p < n && b[p] !== LF) p++;
    i = p + 1;

    if (faccao[id] === undefined) {
      let q = medidaIni;
      while (q < p && b[q] !== PONTO_E_VIRGULA) q++;
      registrar(
        faccao,
        agressoresDe,
        id,
        texto(b, facIni, facFim),
        q < p ? texto(b, q + 1, p) : '',
      );
    }

    // Quase toda linha repete o timestamp da anterior: comparar os bytes evita criar a string
    let mesmoTimestamp = tFim - tIni === tsTam;
    if (mesmoTimestamp) {
      for (let k = tsTam - 1; k >= 0; k--) {
        if (b[tIni + k] !== b[tsIni + k]) {
          mesmoTimestamp = false;
          break;
        }
      }
    }
    if (!mesmoTimestamp) {
      const ts = texto(b, tIni, tFim).replace(ASPAS_CR, '');
      const existente = grupoDoTimestamp.get(ts);
      foraDeOrdem ||= existente !== undefined;
      grupo = existente ?? abrirGrupo(ts, timestamps, inicios, grupoDoTimestamp, total);
      trechoGrupo.push(grupo);
      trechoInicio.push(total);
      tsIni = tIni;
      tsTam = tFim - tIni;
    }

    if (ultimoGrupoDe[id] === grupo) continue;
    ultimoGrupoDe[id] = grupo;
    if (total === capacidade) {
      capacidade *= 2;
      ids = crescerInt32(ids, capacidade);
      lats = crescerFloat64(lats, capacidade);
      lons = crescerFloat64(lons, capacidade);
    }
    ids[total] = id;
    lats[total] = lat;
    lons[total++] = lon;
  }
  inicios.push(total);
  estado.ids = ids;
  estado.lats = lats;
  estado.lons = lons;

  const tabela = { ids, lats, lons, timestamps, inicios, total, faccao, agressoresDe };
  return foraDeOrdem ? reagrupar(tabela, trechoGrupo, trechoInicio) : tabela;
}

// Só para arquivos fora de ordem: junta os trechos de cada timestamp em faixas contíguas
// e descarta IDs repetidos que a leitura sequencial não pôde ver.
function reagrupar(t, trechoGrupo, trechoInicio) {
  const G = t.timestamps.length;
  const trechosDe = Array.from({ length: G }, () => []);
  trechoGrupo.forEach((g, k) => trechosDe[g].push(k));
  trechoInicio.push(t.total);

  const ids = new Int32Array(t.total);
  const lats = new Float64Array(t.total);
  const lons = new Float64Array(t.total);
  const inicios = new Array(G + 1);
  const ultimoGrupoDe = [];
  let total = 0;
  for (let g = 0; g < G; g++) {
    inicios[g] = total;
    for (const k of trechosDe[g]) {
      for (let i = trechoInicio[k]; i < trechoInicio[k + 1]; i++) {
        if (ultimoGrupoDe[t.ids[i]] === g) continue;
        ultimoGrupoDe[t.ids[i]] = g;
        ids[total] = t.ids[i];
        lats[total] = t.lats[i];
        lons[total++] = t.lons[i];
      }
    }
  }
  inicios[G] = total;
  return { ...t, ids, lats, lons, inicios, total };
}

function classificar(t, a, b) {
  if (t.agressoresDe.get(a)?.has(b) || t.agressoresDe.get(b)?.has(a)) return 'protetiva';
  const fac = t.faccao[a];
  return fac != null && fac === t.faccao[b] ? 'faccao' : 'generico';
}

function compararEncontros(x, y) {
  if (x.timestamp !== y.timestamp) return x.timestamp < y.timestamp ? -1 : 1;
  return (
    x.monitoradosEncontro[0] - y.monitoradosEncontro[0] ||
    x.monitoradosEncontro[1] - y.monitoradosEncontro[1]
  );
}

// Grid 1D por latitude: um par a menos de 20 m está na mesma célula ou na vizinha,
// então cada ponto só é comparado com os candidatos de 3 células, e não com o grupo inteiro.
function detectar(t, estado) {
  const { ids, lats, lons, inicios, timestamps } = t;
  const cabeca = new Int32Array(MASCARA_GRID + 1).fill(-1);
  if (estado.proximo.length < t.total) {
    estado.proximo = new Int32Array(t.total);
    estado.celula = new Int32Array(t.total);
  }
  const { proximo, celula } = estado;
  const encontros = [];

  for (let g = 0; g < timestamps.length; g++) {
    const ini = inicios[g];
    const fim = inicios[g + 1];
    for (let i = ini; i < fim; i++) {
      const lat = lats[i];
      const c = Math.floor(lat / LIMIAR_LAT);
      for (let v = c - 1; v <= c + 1; v++) {
        for (let j = cabeca[v & MASCARA_GRID]; j !== -1; j = proximo[j]) {
          const dLat = lat - lats[j];
          if (dLat > LIMIAR_LAT || dLat < -LIMIAR_LAT) continue;
          const d = haversine(lats[j], lons[j], lat, lons[i]);
          if (d < DISTANCIA_MAX) {
            const a = ids[j];
            const b = ids[i];
            encontros.push({
              tipo: classificar(t, a, b),
              monitoradosEncontro: a < b ? [a, b] : [b, a],
              timestamp: timestamps[g],
              posicoes: {
                [a]: { lat: lats[j], lon: lons[j] },
                [b]: { lat, lon: lons[i] },
              },
              distanciaMetros: d,
            });
          }
        }
      }
      const h = c & MASCARA_GRID;
      celula[i] = h;
      proximo[i] = cabeca[h];
      cabeca[h] = i;
    }
    for (let i = ini; i < fim; i++) cabeca[celula[i]] = -1;
  }
  return encontros.sort(compararEncontros);
}

function listarDatasets() {
  return readdirSync('.')
    .filter((nome) => /^dataset.*\.txt$/.test(nome))
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
}

// Início da primeira linha, depois de `base`, com timestamp diferente do da linha anterior.
// O corte depende só dos bytes do arquivo: dois trechos vizinhos chegam à mesma fronteira e
// nenhum timestamp fica dividido. Retorna -1 se a janela não bastar para encontrá-la.
function proximoCorte(buf, base, m, chegouAoFim) {
  const semCorte = chegouAoFim ? m : -1;
  const colunaTimestamp = (linha) => {
    let separadores = 0;
    let ini = -1;
    for (let p = linha; p < m && buf[p] !== LF; p++) {
      if (buf[p] !== PONTO_E_VIRGULA) continue;
      if (++separadores === 2) ini = p + 1;
      else if (separadores === 3) return [ini, p];
    }
    return [-1, -1];
  };
  let linha = fimDaLinha(buf, base, m);
  const [refIni, refFim] = colunaTimestamp(linha);
  if (refIni === -1) return semCorte;
  while (linha < m) {
    linha = fimDaLinha(buf, linha, m);
    const [ini, fim] = colunaTimestamp(linha);
    if (ini === -1) return semCorte;
    let igual = fim - ini === refFim - refIni;
    for (let k = 0; igual && k < fim - ini; k++) igual = buf[ini + k] === buf[refIni + k];
    if (!igual) return linha;
  }
  return semCorte;
}

function processarBytes(bytes, estado) {
  const tabela = carregar(bytes, estado);
  let menorTimestamp = '';
  let maiorTimestamp = '';
  for (const ts of tabela.timestamps) {
    if (menorTimestamp === '' || ts < menorTimestamp) menorTimestamp = ts;
    if (ts > maiorTimestamp) maiorTimestamp = ts;
  }
  return { encontros: detectar(tabela, estado), linhas: tabela.total, menorTimestamp, maiorTimestamp };
}

function processarSequencial(arquivo) {
  const buffer = readFileSync(arquivo);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
  return processarBytes(bytes, novoEstado());
}

// Laço de cada worker: pega o próximo trecho da fila (um contador atômico compartilhado) até
// acabar o arquivo. Assim, os núcleos mais rápidos processam mais trechos, e o mesmo buffer é
// reaproveitado em vez de cada worker alocar uma parte grande do arquivo.
function consumirFila(arquivo, tamanho, fila) {
  const fd = openSync(arquivo, 'r');
  const buf = new Uint8Array(BYTES_TRECHO + BYTES_JANELA);
  const estado = novoEstado();
  const partes = [];
  for (;;) {
    const trecho = Atomics.add(fila, 0, 1);
    const pos = trecho * BYTES_TRECHO;
    if (pos >= tamanho) break;
    const pedidos = Math.min(buf.length, tamanho - pos);
    let lidos = 0;
    while (lidos < pedidos) {
      const n = readSync(fd, buf, lidos, pedidos - lidos, pos + lidos);
      if (n === 0) break;
      lidos += n;
    }
    const chegouAoFim = pos + lidos >= tamanho;
    const ini = pos === 0 ? 0 : proximoCorte(buf, 0, lidos, chegouAoFim);
    const fim = pos + BYTES_TRECHO >= tamanho ? lidos : proximoCorte(buf, BYTES_TRECHO, lidos, chegouAoFim);
    if (ini === -1 || fim === -1) {
      partes.push({ trecho, semCorte: true });
    } else if (ini < fim) {
      partes.push({ trecho, ...processarBytes(buf.subarray(ini, fim), estado) });
    }
  }
  closeSync(fd);
  return partes;
}

async function processarEmParalelo(arquivo, tamanho, workers) {
  const fila = new Int32Array(new SharedArrayBuffer(4));
  const resultados = await Promise.all(
    Array.from(
      { length: workers },
      () =>
        new Promise((resolver, rejeitar) => {
          const worker = new Worker(new URL(import.meta.url), {
            workerData: { arquivo, tamanho, fila },
          });
          worker.once('message', resolver);
          worker.once('error', rejeitar);
        }),
    ),
  );

  const partes = resultados.flat().sort((x, y) => x.trecho - y.trecho);
  // Sem corte seguro ou com timestamps sobrepostos entre trechos, o arquivo não está ordenado
  // e um par pode ter ficado dividido: a divisão não é confiável, então refaz em uma thread
  if (partes.some((p) => p.semCorte)) return processarSequencial(arquivo);
  const comLinhas = partes.filter((p) => p.linhas > 0);
  for (let k = 1; k < comLinhas.length; k++) {
    if (comLinhas[k].menorTimestamp <= comLinhas[k - 1].maiorTimestamp) return processarSequencial(arquivo);
  }
  return {
    encontros: partes.flatMap((p) => p.encontros).sort(compararEncontros),
    linhas: partes.reduce((soma, p) => soma + p.linhas, 0),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const arquivos = args.length > 0 ? args : listarDatasets();
  if (arquivos.length === 0) {
    console.error('Nenhum dataset*.txt encontrado no diretório atual.');
    process.exit(1);
  }
  mkdirSync('output', { recursive: true });
  const nucleos = availableParallelism();
  const fixo = Number(process.env.DETECTAR_WORKERS); // só para benchmark

  for (const arquivo of arquivos) {
    const fd = openSync(arquivo, 'r');
    const tamanho = fstatSync(fd).size;
    closeSync(fd);
    if (tamanho === 0) {
      console.log(`${arquivo}: vazio, ignorado`);
      continue;
    }
    const inicio = performance.now();
    const workers = Math.min(fixo || FAIXAS_WORKERS.find((f) => tamanho < f.ateBytes).workers, nucleos);
    const { encontros, linhas } =
      workers > 1 ? await processarEmParalelo(arquivo, tamanho, workers) : processarSequencial(arquivo);
    const saida = join('output', `${basename(arquivo, extname(arquivo))}.json`);
    writeFileSync(saida, JSON.stringify(encontros, null, 2));
    const ms = (performance.now() - inicio).toFixed(1);
    console.log(`${arquivo}: ${linhas} linhas, ${encontros.length} encontros → ${saida} (${ms} ms)`);
  }
  process.exit(0);
}

if (isMainThread) {
  await main();
} else {
  const { arquivo, tamanho, fila } = workerData;
  parentPort.postMessage(consumirFila(arquivo, tamanho, fila));
}
