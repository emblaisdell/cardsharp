# Architecture — how the pieces fit together

A map of the whole system and where to pick up each part. For the language itself
see [language-spec.md](language-spec.md); for the ML research and results see
[ml-research.md](ml-research.md), [ml-pytorch-results.md](ml-pytorch-results.md),
and [neural-ismcts.md](neural-ismcts.md).

## The one idea everything is built on

A game is *"the engine enumerates the legal moves at each decision point; a
controller picks one."* Every player — a human clicking in the browser, a random
bot, a linear policy, a neural net, a tree searcher — is just a `Controller` that
answers `choose(player, options, prompt)`. That single seam is what lets the same
`.card` file run in a terminal, in the browser over WebRTC, and inside a self-play
training loop.

## Two engines, same language

The `.card` files are the single source of truth. **Two independent interpreters**
run them, and they are kept in lock-step by a bit-exact PRNG and trace-diff tests.

### TypeScript engine — `packages/core` (zero deps, Node 22 native TS)

Layered so the cheap path stays cheap and only search pays for resumability:

| Layer | File | Role |
|---|---|---|
| Lexer → Parser → AST | `src/lexer.ts` `src/parser.ts` `src/ast.ts` | ♠# → AST |
| Type checker | `src/checker.ts` | static errors before runtime |
| Values | `src/values.ts` | Card / Player / Pile / ZoneHandle / Labeled / Record |
| State + visibility | `src/state.ts` | zones, `clone()`, `determinize()`, `observe(viewer)` |
| **Layer 0** generator interpreter | `src/interpreter.ts` | yields `ChoiceRequest`s; the default runner |
| **Layer 1** synchronous evaluator | `src/vm-sync.ts` | same semantics, plain recursion; rollout primitive |
| **Layer 2** resumable stepper | `src/vm.ts` (`Machine`) | explicit stack; **suspends at `choose`, is cloneable** — this is what search needs |
| Stdlib | `src/builtins.ts` | `move`, `deal`, `findMelds`, `choose`, … |
| Driver | `src/engine.ts` | `compile` / `runGame` |

`Machine.clone()` + `state.determinize()` is the key capability: clone a live game,
reshuffle the cards the searcher can't see, and roll out — fair information-set
search with no hidden info leaking in.

### Python engine — `packages/pyengine/cardsharp` (faithful port, for ML)

A port so reinforcement-learning self-play runs **in-process** (no Node subprocess
per step). Same `.card` files, bit-identical dealing.

- `rng.py` — bit-exact mulberry32 (matches TS float-for-float).
- `values.py` `lexer.py` `parser.py` `state.py` — mirror the TS types/engine.
- `interp.py` — synchronous interpreter + full stdlib; `choose(...)` calls the
  controller directly (all that self-play needs).
- `vm.py` — the **cloneable resumable stepper** (port of `core/src/vm.ts`), so
  neural MCTS can clone+determinize mid-game *inside* Python.

**Equivalence is tested, not assumed:**
- `pyengine/crossval.sh` diffs the full decision trace of every game between the
  two engines (0 mismatches).
- `pyengine/test_engine.py` — RNG stream + every game runs.
- `pyengine/test_vm.py` — the Machine is byte-identical to the interpreter, and
  clones are independent (determinizing a clone leaves the original untouched).

## The players (controllers), weakest → strongest

| Player | Where | Idea |
|---|---|---|
| Random | everywhere | uniform over legal options |
| **Linear policy** | `packages/ml/src/policy.ts` + `models/*.json` | softmax over 26-d generic per-option features; REINFORCE self-play (`trainer.ts`) |
| **DMC / PPO nets** | `pyengine/ml/{dmc,ppo}.py` + `net.py` | card-matrix state encoder + per-option action scorer; DouZero-style DMC and PPO self-play (PyTorch) |
| **Fair IS-MCTS** | `packages/ml/src/ismcts.ts` | clone the `Machine`, determinize, UCT + heuristic rollout scored by `score` |
| **Neural IS-MCTS (hybrid)** | `packages/ml/src/neural-ismcts.ts` | IS-MCTS with the net as a PUCT prior; `leaf:"rollout"` (default) or `"net"` |
| **AlphaZero-trained net** | `pyengine/ml/{search,alphazero}.py` | policy iteration: MCTS self-play → train net toward (π, z) → repeat |

The nets are trained in Python, exported to JSON (`pyengine/ml/export_nets.py` →
`models/py/*.netjson`), and re-loaded in TS by `packages/ml/src/netplay.ts`
(`NetPlayer`), whose encoder mirrors the Python one bit-for-bit. That JSON bridge
is what lets the browser and the TS head-to-head harnesses run the neural players.

### Head-to-head harnesses (`packages/ml/*.mjs`)
- `h2h.mjs` — linear vs IS-MCTS
- `net-vs-ismcts.mjs [dmc|ppo]` — bare net vs IS-MCTS
- `hybrid-arena.mjs [dmc|ppo]` — the hybrid vs its two parents
- `bench.mjs` — linear benchmark table (`docs/ml-benchmarks.md`)

## Multiplayer — `packages/web` + `packages/server`

Static client, **authoritative host**: the first peer runs the `Machine` and all
bots; guests are thin clients that receive only their own masked observation.
Hidden cards never leave the host. WebRTC data channels carry gameplay
(`web/public/net.js`); the zero-dependency server (`server/server.mjs`) only does
matchmaking + SDP/ICE signaling and serves the static bundle. `web/build.mjs`
strips the TS to `public/lib/` and copies games + models (including the DMC
`.netjson` nets for the in-browser hybrid bot).

## How to run each piece

```bash
# TS engine
node packages/cli/src/main.ts run games/gofish.card --players 3 --seed 1
node --test 'packages/core/test/*.test.ts'   # 53 tests: unit + equivalence + clone

# Python engine + ML (needs the venv, see packages/pyengine/README.md)
cd packages/pyengine
bash crossval.sh                                   # TS↔Python equivalence
../../.venv/bin/python test_vm.py                  # stepper + clone tests
../../.venv/bin/python -m ml.dmc ../../games/thirtyone.card --seconds 120
../../.venv/bin/python -m ml.alphazero ../../games/thirtyone.card --iters 12
../../.venv/bin/python -m ml.dashboard 8770        # live training dashboard

# neural players in TS (after `python -m ml.export_nets`)
node packages/ml/hybrid-arena.mjs dmc

# multiplayer
node packages/server/server.mjs                    # open two tabs at :8090
```

## State of the work / where to pick up

Everything on the original roadmap plus the ML research thread is implemented and
tested (see the README status table). Nothing is committed yet — the whole session
lives in the working tree (untracked). Natural next steps, if wanted:

- **Scale AlphaZero** — the loop works (Thirty-One 0.53→0.72 vs random on one CPU);
  it's compute-bound. Longer runs, more sims, or tabula-rasa (no warm start).
- **Ship the AZ-trained nets** to the browser hybrid (same `.netjson` path).
- **Parallel self-play actors** (DouZero's lever) to speed the long games, whose
  throughput is the current bottleneck for training and eval.
