#!/usr/bin/env bash
# Cross-validate the Python ♠# port against the TS engine: identical deterministic
# controller, identical decision trace + winners required, across games/seeds/seats.
set -u
cd "$(dirname "$0")"
GAMES_DIR=../../games
PY=../../.venv/bin/python
pass=0; fail=0
# game:minplayers:maxplayers-to-test
declare -A SEATS=(
  [gofish]="2 3 4" [oldmaid]="3 4" [blackjack]="2 3" [thirtyone]="2 3 4"
  [crazybridge]="3 4" [moneymoneymoney]="3 4" [tableless]="2 4" [thewall]="2 3"
)
for game in gofish oldmaid blackjack thirtyone crazybridge moneymoneymoney tableless thewall; do
  for np in ${SEATS[$game]}; do
    for seed in 1 7 42 100 2024; do
      g=$GAMES_DIR/$game.card
      ts=$(node trace_ts.mjs "$g" "$np" "$seed" 2>/dev/null)
      py=$($PY trace_py.py "$g" "$np" "$seed" 2>/dev/null)
      if [ "$ts" == "$py" ] && [ -n "$ts" ]; then
        pass=$((pass+1))
      else
        fail=$((fail+1))
        echo "MISMATCH $game np=$np seed=$seed"
        if [ -z "$ts" ]; then echo "  (TS produced no output)"; fi
        if [ -z "$py" ]; then echo "  (PY produced no output)"; fi
        # show first differing position
        $PY - "$ts" "$py" <<'EOF'
import sys, json
try:
    a = json.loads(sys.argv[1]); b = json.loads(sys.argv[2])
except Exception as e:
    print("   parse error:", e); sys.exit()
if a.get("winners") != b.get("winners"):
    print("   winners TS", a.get("winners"), "PY", b.get("winners"))
ta, tb = a.get("trace", []), b.get("trace", [])
if len(ta) != len(tb): print(f"   len TS={len(ta)} PY={len(tb)}")
for i,(x,y) in enumerate(zip(ta,tb)):
    if x != y:
        print(f"   first diff @ {i}: TS={x!r} PY={y!r}")
        print("   ctx TS:", ta[max(0,i-2):i+3])
        print("   ctx PY:", tb[max(0,i-2):i+3])
        break
EOF
      fi
    done
  done
done
echo "----"
echo "PASS=$pass FAIL=$fail"
