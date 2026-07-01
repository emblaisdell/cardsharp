"""Emit the same deterministic decision trace using the Python port, for diffing
against trace_ts.mjs. Controller always picks options[0].

    python trace_py.py <game.card> <players> <seed>
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cardsharp import run_game, display  # noqa: E402

file, players, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
with open(file) as f:
    src = f.read()

trace = []
MAX_STEPS = 100000  # mirror trace_ts.mjs / runGame's maxSteps; fail fast, don't hang


def decide(req):
    if len(trace) >= MAX_STEPS:
        sys.stderr.write(f"trace_py: exceeded {MAX_STEPS} decisions (runaway) — aborting\n")
        sys.exit(2)  # no stdout, so crossval flags a mismatch instead of hanging/OOM
    ans = req.options[0]
    trace.append(f"{req.player.id}:{display(ans)}")
    return ans


winners, state, interp = run_game(src, decide, num_players=players, seed=seed, quiet=True)
print(json.dumps({
    "trace": trace,
    "winners": [p.id for p in winners],
    "steps": len(trace),
}, separators=(",", ":")))
