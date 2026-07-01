# pyengine — Python ♠# interpreter + PyTorch self-play

A faithful Python port of the ♠# engine, built so reinforcement-learning
self-play can run **in-process** (no Node subprocess per step), plus two neural
self-play trainers recommended in [docs/ml-research.md](../../docs/ml-research.md):
**DMC** (DouZero-style Deep Monte-Carlo) and **PPO**.

It runs the **same `.card` files** as the TS engine, deals/shuffles identically
(bit-exact mulberry32 PRNG), and is verified against the TS engine by diffing the
full decision trace of every game (`crossval.sh`, 0 mismatches).

```
packages/pyengine/
├── cardsharp/            # the interpreter (faithful port of packages/core)
│   ├── rng.py            # bit-exact mulberry32
│   ├── values.py         # Card / Player / Pile / ZoneHandle / Labeled / Record
│   ├── lexer.py  parser.py  state.py
│   ├── interp.py         # synchronous evaluator + full standard library
│   │                     #   choose(...) calls the controller (decide) directly
│   └── vm.py             # resumable, CLONEABLE stepper (port of core/vm.ts) —
│                         #   suspends at choose; clone+determinize for search
├── ml/
│   ├── features.py       # generic per-option features (TS-compatible) + card-matrix state
│   ├── net.py            # shared net: trunk + per-option action scorer + value head
│   ├── selfplay.py       # one-episode runner (policy = decide callback)
│   ├── dmc.py            # Deep Monte-Carlo self-play (DouZero)
│   ├── ppo.py            # clipped policy-gradient self-play (+entropy)
│   ├── linear.py         # load & play the TS linear JSON models (for baselines)
│   ├── evaluate.py       # vs-random + head-to-head, seat-rotated
│   ├── search.py         # neural IS-MCTS on the cloneable Machine (prior + value)
│   ├── alphazero.py      # AlphaZero policy iteration: MCTS self-play -> train -> repeat
│   └── run_experiments.py# train both methods on all 8 games -> docs/ml-pytorch-results.md
├── test_engine.py        # RNG + run-every-game smoke tests
├── test_vm.py            # Machine == interpreter equivalence + clone independence
├── crossval.sh           # diff Python vs TS decision traces (equivalence)
└── trace_ts.mjs / trace_py.py   # deterministic trace emitters used by crossval
```

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install numpy torch --index-url https://download.pytorch.org/whl/cpu
```

## Use

```bash
cd packages/pyengine
../../.venv/bin/python test_engine.py          # sanity tests
bash crossval.sh                               # equivalence vs the TS engine

# train one agent
../../.venv/bin/python -m ml.dmc ../../games/gofish.card --players 2 --seconds 120
../../.venv/bin/python -m ml.ppo ../../games/thirtyone.card --players 2 --seconds 120

# train both methods on all games + benchmark -> docs/ml-pytorch-results.md
../../.venv/bin/python -m ml.run_experiments --seconds 60 --games 30

# long PARALLEL run: one process per game, 3 concurrent, longest-first
bash run_long.sh                                # writes models/py/<game>_result.json
../../.venv/bin/python -m ml.merge_results      # combine fragments -> docs/ml-pytorch-results.md (anytime)

# AlphaZero policy iteration (needs the cloneable Machine in vm.py)
../../.venv/bin/python -m ml.alphazero ../../games/thirtyone.card --iters 12 --games 16 --sims 40
```

## Live training dashboard

A zero-dependency web UI that parses the training logs on each poll and draws the
**DMC loss** and **PPO win-rate** curves per game, with a live status table and
final win-rates as each game finishes:

```bash
../../.venv/bin/python -m ml.dashboard 8770 /tmp/claude-1000   # logdir = where train_*.log live
# open http://localhost:8770   (auto-refreshes every 3s)
```

It works with both `run_long.sh` and a single `ml.train_one`, and needs no
instrumentation — it reads the same log lines the trainers already print.

## How it maps to the recommendation

Both trainers share one network (`ml/net.py`): a **permutation-invariant
card-matrix** state encoder feeds a trunk, and a **per-option action scorer** rates
each legal move — so a single architecture handles every game's different,
variable-sized action set (DouZero's action-encoding trick). DMC regresses
`Q(state, action)` toward the seat's Monte-Carlo outcome; PPO uses the same scorer
as policy logits with the value head as a baseline.

## Notes & limits

- The interpreter is a tree-walker (clarity over speed); throughput is the
  bottleneck for the long games (contract rummy, the money game run to hundreds–
  thousands of decisions), so short budgets under-train those. For serious runs,
  give more wall-clock or parallelize self-play actors (DouZero's lever).
- These trainers are **strength-maximizers via self-play**, not equilibrium
  solvers — strong against the self-play population but exploitable in principle
  (fine for our mostly multi-player, non-zero-sum games). See ml-research.md.
- Neural-guided **Information-Set MCTS** (the report's #2 method) reuses this same
  network as a value/policy prior on top of the existing cloneable TS `Machine`;
  it needs the resumable stepper's mid-game cloning, which this synchronous port
  intentionally doesn't replicate.
