#!/bin/bash
# Benchmark matrix: every dataset x {20k, 40k}, release-default trainer,
# eval8 PSNR + train-only timing. Cells run serially (one GPU); each cell is
# its own page load (the no-reload contamination rule). Results accumulate
# into tests/bench/results/bench_results.jsonl.
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
BASE="http://localhost:8734/tests/bench/bench_run.html"
OUT="tests/bench/results/bench_results.jsonl"
cd /c/Dev/arrival.space/Browser_3DGS

SETS="synthetic camping truck garden bicycle playroom train bar360"

run_cell () {
  local set="$1"; local iters="$2"
  local status="tests/bench/results/bench_${set}_${iters}_status.json"
  local result="tests/bench/results/bench_${set}_${iters}_result.json"
  powershell -Command "Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1
  sleep 3
  rm -f "$status" "$result"
  ("$CHROME" --headless=new --enable-unsafe-webgpu --use-angle=d3d11 \
    --user-data-dir=/c/Users/trt/AppData/Local/Temp/hlchrome_train \
    --window-size=1400,900 "$BASE?set=$set&iters=$iters" >/dev/null 2>&1 &)
  sleep 20
  if [ ! -f "$status" ]; then echo "[$set/$iters] FAILED TO START"; return 1; fi
  while true; do
    sleep 30
    S=$(cat "$status" 2>/dev/null)
    TS=$(echo "$S" | grep -oE '"ts":[0-9]+' | grep -oE '[0-9]+')
    NOW=$(date +%s%3N)
    AGE=$(( (NOW - ${TS:-0}) / 60000 ))
    if echo "$S" | grep -qE '"phase":"(DONE|ERROR)"'; then break; fi
    if [ "$AGE" -gt 8 ]; then echo "[$set/$iters] STALE ${AGE}min: $S" ; return 1; fi
  done
  if [ -f "$result" ]; then
    cat "$result" >> "$OUT"; echo >> "$OUT"
    echo "[$set/$iters] $(cat "$result")"
  else
    echo "[$set/$iters] ENDED WITHOUT RESULT: $(cat "$status")"
  fi
}

echo "=== bench matrix start $(date) ==="
for set in $SETS; do
  for iters in 20000 40000; do
    run_cell "$set" "$iters"
  done
done
powershell -Command "Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1
echo MATRIX_DONE
