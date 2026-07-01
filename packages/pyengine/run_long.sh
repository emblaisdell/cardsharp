#!/usr/bin/env bash
# Long parallel training: one process per game, 3 concurrent (4-core box, torch
# pinned to 1 thread each). Longest games first (LPT) to balance makespan.
# Writes models/py/<game>_{dmc,ppo}.pt + <game>_result.json, then merges into
# docs/ml-pytorch-results.md.  Run in background; check progress with
#   python -m ml.merge_results   (anytime, for partial results)
set -u
cd "$(dirname "$0")"
PY=../../.venv/bin/python
LOGDIR=/tmp/claude-1000
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1

# game players seconds-per-method eval-games eval-decision-cap
JOBS=(
  "tableless 2 1200 20 1500"
  "crazybridge 3 1200 20 1500"
  "moneymoneymoney 3 1200 20 1500"
  "gofish 2 900 24 2500"
  "thirtyone 2 900 24 2500"
  "thewall 2 900 24 2500"
  "blackjack 2 600 30 4000"
  "oldmaid 3 600 30 4000"
)
MAXP=3

run_job() {
  local game=$1 players=$2 secs=$3 eg=$4 cap=$5
  $PY -u -m ml.train_one ../../games/$game.card "$players" "$secs" "$eg" 128 "$cap" \
      > "$LOGDIR/train_$game.log" 2>&1
}

echo "launcher start $(date +%H:%M:%S)"
for j in "${JOBS[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge $MAXP ]; do sleep 5; done
  # shellcheck disable=SC2086
  run_job $j &
  echo "  dispatched: $j"
done
wait
echo "all jobs done $(date +%H:%M:%S); merging"
$PY -m ml.merge_results
echo "launcher done $(date +%H:%M:%S)"
