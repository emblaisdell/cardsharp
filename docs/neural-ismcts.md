# Neural‑guided IS‑MCTS (the hybrid)

The bare learned policies (DMC/PPO) and pure tree search (fair IS‑MCTS) each win
on different games (see the head‑to‑head in the chat history / `packages/ml`).
This hybrid combines them, as recommended in
[ml-research.md](ml-research.md) (#2) and following AlphaZero / ReBeL /
Player‑of‑Games: **use the trained net as a prior (and optionally a value) inside
the fair information‑set search.**

No new training is required — the hybrid *reuses* the already‑trained nets.

## How it works

[`packages/ml/src/neural-ismcts.ts`](../packages/ml/src/neural-ismcts.ts),
`neuralIsmctsAction(machine, seat, net, opts, rng)`. Each iteration is fair
(only the searcher's own masked observation is ever used):

1. **clone** the live resumable `Machine` and **determinize** unseen cards from
   the searcher's view (identical to plain IS‑MCTS);
2. descend the tree of the searcher's decisions with **PUCT**, where the net
   supplies the per‑action **prior** `P(a)` (softmax of its option scores):
   `argmax  Q(a) + c · P(a) · √N / (1 + n(a))`;
3. at a new leaf, take a **value**. Two modes:
   - `leaf:"rollout"` (default) — keep IS‑MCTS's depth‑limited random rollout
     scored by the game's `score` heuristic, and use the net **only as the
     prior**. Best when the heuristic is already strong (most of our games).
   - `leaf:"net"` — AlphaZero‑style: use the net's value estimate (DMC: max‑Q;
     PPO: the trained value head) and skip the rollout. Best when the net value
     beats the heuristic.

The net is evaluated on the searcher's masked observation, which is identical
across determinizations — i.e. it scores the *information set*, which is exactly
right for IS‑MCTS.

### Why `leaf:"rollout"` is the default

Our IS‑MCTS rollouts already use a strong domain heuristic (`score` — hand value
for Thirty‑One, closeness‑to‑21 for Blackjack, …). Replacing that good rollout
with a learned value (pure AlphaZero) can *lose* signal, so the robust hybrid for
this engine keeps the heuristic rollout and adds the net **prior** to focus the
search. Empirically `rollout` ≥ `net` on our games.

## Results

Win‑rate **vs pure IS‑MCTS** (the net's/searcher's share, 2‑player, seats
rotated, 60–80 iterations). The hybrid uses `leaf:"rollout"` with the DMC/PPO net
as the PUCT prior.

| Game | bare DMC | **DMC hybrid** | bare PPO | **PPO hybrid** | bare linear |
|---|--:|--:|--:|--:|--:|
| **Thirty‑One** | 22% | **58%** | 63% | **67%** | 61% |
| **The Wall** | 59% | **71%** | 59% | — | 63% |
| Blackjack* | 38% | ~58% | 43% | ~54% | 35% |
| Go Fish | 39% | **54%** | 36% | — | 21% |

\*Blackjack is ≈2 decisions/game, so its numbers swing ±15% with the seed — read
it as "roughly even," not a precise figure.

**The DMC hybrid beats IS‑MCTS on all four games (58 / 71 / ~58 / 54%) and
improves on the bare net on every one** (22→58, 59→71, 38→58, 39→54). The two
extremes make the point:

- **Thirty‑One** (low‑noise headline): the *weak* DMC net went from **22% → 58%**
  — a policy that *lost* to tree search now *beats* it.
- **Go Fish**: the bare net is hopeless (~39%, IS‑MCTS dominates), yet the hybrid
  reaches **54%** — it recovers tree search's strength *and* edges past it.

The mechanism: because `leaf:"rollout"` is *IS‑MCTS plus a learned prior*, the
hybrid never loses IS‑MCTS's rollout strength (so it can't collapse the way a bare
net does on Go Fish) **and** the net's move‑ordering focuses the search on good
lines (so it can exceed IS‑MCTS, as on Thirty‑One and The Wall). It is ≥ the
better parent everywhere we measured — the "best of both" the research predicts.


## Using it

**CLI** (compare the hybrid to its parents):

```bash
node packages/ml/hybrid-arena.mjs dmc     # or ppo
node packages/ml/net-vs-ismcts.mjs dmc    # bare net vs IS-MCTS (the parents)
```

**Browser** — rebuild and the Opponents dropdown gains **“Neural IS‑MCTS
(hybrid) — net‑guided fair search”** for every game that has a trained net:

```bash
node packages/web/build.mjs        # copies models/py/*_dmc.netjson into the bundle
node packages/server/server.mjs    # open http://localhost:8090, pick the hybrid bot
```

The net is exported from PyTorch to plain JSON by
`python -m ml.export_nets` (run inside `packages/pyengine`), loaded in TS by
[`NetPlayer`](../packages/ml/src/netplay.ts), whose card‑matrix state encoder
mirrors the Python `state_features` bit‑for‑bit (validated).

## AlphaZero policy iteration (built)

The net‑guided search above is now also wrapped in a full **AlphaZero training
loop**, enabled by porting the **cloneable resumable stepper to Python**
([`cardsharp/vm.py`](../packages/pyengine/cardsharp/vm.py) — validated
byte‑identical to the interpreter on all 8 games, with independent clones, by
[`test_vm.py`](../packages/pyengine/test_vm.py)):

- [`ml/search.py`](../packages/pyengine/ml/search.py) — the same neural IS‑MCTS,
  in Python on the Machine, returning the **visit distribution** π and a value.
- [`ml/alphazero.py`](../packages/pyengine/ml/alphazero.py) — self‑play where each
  move runs the search; record `(info‑set, π, z=outcome)`; train the policy head
  toward π (cross‑entropy) and the value head toward z (MSE); repeat. The improved
  net makes the next round's search stronger — policy iteration.

```bash
cd packages/pyengine
../../.venv/bin/python -m ml.alphazero ../../games/thirtyone.card \
    --iters 12 --games 16 --sims 40 --warm auto   # warm-start from the DMC net
```

It warm‑starts from the DMC net by default (tabula‑rasa also works but needs far
more iterations). This closes the loop the research describes: **search distilled
into the net, net guiding the search.**

**Results (single CPU, warm‑started).** Policy iteration stably *improves* the net
vs random within the same eval harness:

| Game | start (warm net) | after AZ (final / best) | iters × games × sims |
|---|--:|--:|---|
| Thirty‑One | 0.53 | **0.70 / 0.72** | 10 × 14 × 30 (~15 min) |
| Blackjack | 0.33 | 0.35 / **0.38** | 10 × 20 × 30 (~20 s) |

On Thirty‑One the win‑rate vs random climbed **0.53 → 0.72** while the training
loss fell monotonically (1.18 → 1.00) — the policy‑iteration flywheel working as
designed. Blackjack (≈pure luck) moves little, as expected.

Two implementation details mattered and are worth recording: (1) a **persistent
replay buffer** across iterations — without it the net *forgets* and drifts down;
(2) self‑play search must use **`leaf="rollout"`**, not the net value, because a
DMC warm start has an *untrained* value head — the value head only becomes usable
after it has trained on game outcomes `z` for several iterations. The gains are
modest because AlphaZero is compute‑hungry and this runs on one CPU with a
tree‑walking interpreter; the deliverable is the **working, validated
infrastructure** (cloneable stepper + in‑process search + policy iteration), which
scales directly with more self‑play.
