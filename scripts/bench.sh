#!/usr/bin/env bash
# Uma execução por dataset, intercalando os datasets a cada rodada. Reporta duas medidas:
# o processo completo e o algoritmo (o tempo que o próprio programa imprime, sem a partida do runtime).
# Uso: scripts/bench.sh [repetições]   (padrão: 30)
# CPUS=0-15 scripts/bench.sh fixa os núcleos, útil em CPU híbrida (núcleos P e E).
# RUNTIME=/caminho/do/node scripts/bench.sh usa outro executável do Node (padrão: node).
set -euo pipefail

REPS="${1:-30}"
RUNTIME="${RUNTIME:-node}"
PREFIXO=()
if [[ -n "${CPUS:-}" ]]; then PREFIXO=(taskset -c "$CPUS"); fi

DATASETS=()
for f in dataset*.txt; do
  if [[ -s "$f" ]]; then DATASETS+=("$f"); fi
done

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

for ((r = 0; r <= REPS; r++)); do
  for f in "${DATASETS[@]}"; do
    ini="$(date +%s%N)"
    saida="$("${PREFIXO[@]}" $RUNTIME src/index.js "$f")"
    fim="$(date +%s%N)"
    alg="${saida##*(}"
    alg="${alg%% ms)*}"
    # a rodada 0 só aquece o cache de disco
    if ((r > 0)); then echo "$f $(((fim - ini) / 1000)) $alg" >>"$TMP"; fi
  done
done

echo "$($RUNTIME --version) | $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs) | ${CPUS:-sem fixar núcleos} | $REPS repetições"
sort -k1,1V "$TMP" | awk '
  function fecha() {
    if (n) { printf "%-14s processo %8.1f ms   algoritmo %8.1f ms\n", d, s / n / 1000, a / n; sp += s / n; sa += a / n }
  }
  $1 != d { fecha(); d = $1; n = 0; s = 0; a = 0 }
  { n++; s += $2; a += $3 }
  END { fecha(); printf "%-14s processo %8.1f ms   algoritmo %8.1f ms\n", "soma (médias)", sp / 1000, sa }'
