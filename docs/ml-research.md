# Beyond linear: RL & search for imperfect-information card games

*An actionable survey for ♠#, scoped to our engine: a deterministic interpreter that
exposes, at each decision, the acting player's **masked observation**, the **legal
moves** (a list of options), and a higher-is-better terminal **score**; 2–6 players;
games from short (Blackjack, Go Fish) to thousands of decisions (Crazy Bridge,
Money Money Money). Hidden info = opponents' hands + face-down deck order. We
already have a random bot, a linear REINFORCE bot, and a fair determinized
Information-Set MCTS bot.*

> **Provenance note.** The automated deep-research workflow's adversarial
> *verification* step was rate-limited (session limit) and returned no votes, so it
> reported "inconclusive." The findings below were re-gathered and corroborated by
> direct web searches against primary sources; every load-bearing claim links to a
> paper. Confidence is flagged per claim.

---

## TL;DR recommendation

For **our** setting — mostly multi-player, **not** strictly two-player zero-sum,
variable/large action sets, single machine, PyTorch — the right first build is
**not** a CFR/NFSP equilibrium solver. Those have clean guarantees only in
two-player zero-sum games, which most of our games are not. Build, in order:

1. **Deep Monte-Carlo (DMC) self-play, DouZero-style** — the proven practical recipe
   for *exactly* this kind of game (3-player, imperfect info, huge variable action
   space, single GPU/CPU, days of training). It learns `Q(infoset, action)` by
   regression to Monte-Carlo episode returns, encoding **each legal action** as a
   feature vector so one network handles variable move sets and generalizes to
   unseen actions. This is the smallest step from our current linear policy that
   gives a large strength jump, and it reuses our `(observation, legalMoves, score)`
   interface directly. *[Recommendation; high confidence it fits.]*

2. **Neural-guided fair IS-MCTS** — upgrade the IS-MCTS we already have by replacing
   random rollouts with the DMC value net (and using a policy head as the search
   prior). This is the "determinized AlphaZero" baseline, which is
   [surprisingly strong for imperfect-information games](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2023.1014561/full).
   It shares the encoder with step 1, so it's cheap to add.

3. *(Optional, for the 2-player games where we care about exploitability)* a
   **regularized policy-gradient self-play** (PPO with high entropy, or Magnetic
   Mirror Descent). Recent large-scale evidence says simple PG methods **match or
   beat** NFSP/PSRO/CFR-family methods on exploitability while being far simpler.

Skip Deep CFR / NFSP / ReBeL as a *first* build: they're heavier, mostly
two-player-zero-sum, and the PG result below undercuts their practical edge.

---

## Method families, scored for our setting

| Family | Targets (approx.) Nash? | Multi-player / non-zero-sum | Variable action sets | Single-machine cost | Fit here |
|---|---|---|---|---|---|
| **DMC self-play (DouZero)** | No — strong vs self-play population | ✅ designed for 3-player card game | ✅ action-encoding is its core trick | ✅ single GPU, days; scales down to CPU | **Best first build** |
| **Neural IS-MCTS / determinized AlphaZero** | No (heuristic) | ✅ | ✅ (search over legal options) | ✅ reuses our Machine + encoder | **Strong second** |
| **PPO / MMD self-play** | Approx. Nash in 2p-zs (empirically) | ⚠️ guarantees only 2p-zs | ✅ with action embeddings | ✅ cheap | Good for 2p exploitability |
| **NFSP** | ✅ 2p-zs | ❌ weak outside 2p-zs | ✅ | medium | Skip first |
| **Deep CFR / MCCFR / ESCHER / DREAM** | ✅ 2p-zs | ❌ | needs per-game care | medium–high | Skip first |
| **PSRO / P2SRO / XDO** | ✅ 2p-zs (double oracle) | ⚠️ scales poorly in #players | ✅ | high (population) | Skip |
| **ReBeL / Player of Games** | ✅ 2p-zs, superhuman poker | ⚠️ PoG general but heavy | ✅ | high (PBS machinery) | Overkill |

### The methods in one line each

- **DMC / DouZero** — enhances classic Monte-Carlo with a deep net, **action
  encoding (cards as matrices)**, and parallel actors; trains from scratch on a
  single 4-GPU server in *days* and beat 344 agents on Botzone for DouDizhu, a
  3-player imperfect-info card game with a massive turn-varying action set.
  [arXiv:2106.06135](https://arxiv.org/abs/2106.06135),
  [ICML PMLR v139](https://proceedings.mlr.press/v139/zha21a/zha21a.pdf); integrated
  in [RLCard](https://arxiv.org/pdf/1910.04376) ([rlcard.org](https://rlcard.org/)).
  *[High confidence.]*
- **NFSP** — deep RL + fictitious self-play; first end-to-end deep method to
  approach Nash in imperfect-info games (Leduc, Limit Hold'em). Was the leading
  function-approximation method until Deep CFR.
  [arXiv:1603.01121](https://arxiv.org/pdf/1603.01121). *[High confidence.]*
- **Deep CFR** — neural counterfactual regret minimization; removes hand-crafted
  abstraction and **outperforms NFSP**; first non-tabular CFR to scale.
  [arXiv:1811.00164](https://arxiv.org/pdf/1811.00164). MCCFR variants
  (external/outcome sampling), DREAM, ESCHER reduce variance/cost. *[High confidence.]*
- **PG is competitive** — "Reevaluating Policy Gradient Methods for
  Imperfect-Information Games": over **7000 runs**, NFSP, PSRO, ESCHER, and R-NaD
  **fail to outperform** generic PG (PPO, PPG, MMD) on **exploitability**.
  Caveats: tested on **two-player zero-sum** hidden-action games (Dark Hex, Phantom
  Tic-Tac-Toe), and the result *depends on high entropy regularization*
  (coeff. 0.05–0.2, well above library defaults).
  [arXiv:2502.08938](https://arxiv.org/html/2502.08938v1),
  [OpenReview](https://openreview.net/forum?id=vClBDezZUo). *[High confidence, scoped.]*
- **PSRO / P2SRO / XDO** — double-oracle + deep RL, converge to Nash in the limit
  (2p-zs); P2SRO parallelizes, XDO is an extensive-form double oracle.
  [P2SRO arXiv:2006.08555](https://arxiv.org/abs/2006.08555),
  [XDO (NeurIPS 2021)](https://proceedings.neurips.cc/paper/2021/file/c2e06e9a80370952f6ec5463c77cbace-Paper.pdf).
  *[Medium confidence on details.]*
- **ReBeL** — self-play RL **+ depth-limited search** over *public belief states*
  with a value net; low exploitability + superhuman heads-up no-limit hold'em with
  little domain knowledge; reduces to **AlphaZero** in perfect-info games.
  [arXiv:2007.13544](https://arxiv.org/pdf/2007.13544). **Player of Games** extends
  this to one algorithm strong in chess, Go, poker, and Scotland Yard. *[High
  confidence; both are 2p-zs-centric and heavy.]*

---

## Encoding a card-game information set as a neural input

Three problems, three standard answers — all compatible with one shared encoder:

**1. A hand/pile is a *set*, not a sequence.** Order is meaningless and size varies,
so the encoder must be **permutation-invariant**. Two practical options:

- **Card-matrix one-hot (DouZero):** represent a card collection as a fixed
  4×13 (suit × rank) binary matrix (or 4×13×k for multiplicities). Cheap, fixed-size,
  flatten → MLP. This is what DouZero uses and it works well for standard decks.
- **Deep Sets / attention:** embed each card, then pool with a permutation-invariant
  op (sum/mean/max), optionally a Set Transformer for card-card interactions.
  [Set Transformer / permutation-invariant RL](https://arxiv.org/pdf/2109.02869),
  [exchangeable input representations](https://arxiv.org/pdf/2003.09022).
  More expressive than the flat matrix when *relations* between cards matter (melds,
  runs) — relevant for Crazy Bridge / Thirty-One.

For ♠# specifically: one card-matrix **per visible zone** (our hand, each public
pile, books, discard) + scalar features (zone sizes, turn index, our seat, scores).
Hidden zones contribute only their **count** (the mask already enforces this in
`state.observe`).

**2. Public state & history.** Concatenate per-zone matrices + scalars. For
long-horizon games where history matters (who asked for what in Go Fish, melds laid
down), add either an explicit recent-action buffer encoded as card-matrices, or a
GRU/LSTM over the per-turn observation. Start stateless (Markov-ish) — most of our
games are nearly fully described by the current observation + score.

**3. Variable legal-move set.** *Do not* use a fixed action head. Instead **encode
each legal option** (it's a `Card`, `Player`, number, bool, or "decline" in our
engine — we already featurize options in `packages/ml/src/features.ts`) into the
same embedding space and **score each option** with the net:
`logit_i = f(state_embed, option_embed_i)`, then softmax over the *actual* legal
options. This is DouZero's action-encoding idea and the pointer/action-embedding
pattern; it makes **one network work across all 8 games** regardless of action-space
shape, and lets it generalize to options never seen in training. *[High confidence —
this is the key architectural decision.]*

---

## Training practicalities on one machine

- **Reward.** Use our per-player **score** directly (it's higher-is-better and may be
  negative), or win/lose ∈ {0,1}. The score is a gift: it enables **reward shaping**
  and lets value bootstrapping / depth-limited rollouts terminate early (we already
  exploit this in IS-MCTS).
- **Sample efficiency vs. wall-clock.** DMC is sample-hungry but each sample is cheap
  (just play to terminal and regress to the return); **parallel self-play actors** are
  the lever (DouZero generates thousands of samples/sec). On CPU, run N worker
  processes producing episodes into a replay buffer; one learner trains the net.
  PG/PPO is more sample-efficient per environment step but needs careful entropy
  tuning.
- **Variance reduction.** Average/target networks (DMC), baselines/critics (PPO),
  and the score-as-baseline all reduce the high variance of Monte-Carlo returns.
- **Exploit vs. equilibrium — and why it matters for *fairness*.** DMC/PPO self-play
  produce play that is **strong against the self-play population** but **not provably
  Nash**, so a tailored opponent could exploit them. CFR/NFSP/ReBeL/QFR/ACH target
  **approximate Nash** (unexploitable) but only with **two-player zero-sum**
  guarantees. Our games are mostly >2 players and non-zero-sum, where Nash is neither
  unique nor practically computable — so **self-play strength is the right objective
  for most of ♠#**, and we reserve exploitability analysis for the 2-player games
  (Blackjack heads-up, The Wall 2p).
- **Evaluation.** (a) **Head-to-head** vs random / linear / IS-MCTS (we already have
  `packages/ml/h2h.mjs` and `arena.ts` — extend them). (b) For 2-player games,
  **best-response / exploitability**: our engine can compute an approximate best
  response by treating the opponent's net as fixed and searching/training against it;
  report the gap. (c) **NashConv** (sum of each player's best-response gain) where
  feasible. OpenSpiel offers reference exploitability tooling if we want to
  cross-check on a standard game.

---

## Concrete plan (PyTorch + a Python ♠# interpreter)

The agreed approach is to **port the ♠# interpreter to Python** so self-play runs
in-process (no subprocess/IPC per step). Steps:

1. **Python interpreter (`packages/pyengine/`).** Port the resumable stepper: expose
   a gym-like API — `reset(seed) -> obs`, `legal_options()`, `step(i) -> (obs, done)`,
   `scores() -> [float]`, plus `observe(player)` masking. Mirror the deterministic RNG
   so games replay identically to the TS engine (validate with shared seeds against
   `node ... run --seed`). Reuse the `.card` files unchanged.
2. **Shared encoder (`encoder.py`).** Observation → per-zone card-matrices + scalars;
   option → option-embedding (card/player/number/bool/decline). Net:
   `state_trunk` (MLP or Deep Sets) + `action_scorer` producing one logit per legal
   option, and a scalar **value head** (predicts the seat's terminal score).
3. **DMC trainer (`dmc.py`).** Parallel self-play actors → replay buffer of
   `(infoset, chosen_option, return)`; learner regresses `Q(infoset, option)` to the
   Monte-Carlo return; ε-greedy/softmax behavior policy; periodic target-net sync.
   Budget logging like our TS trainer (`maxMs`, samples/sec, wall-clock) so we can
   compare compute across methods — matching the "document exactly how much compute"
   requirement.
4. **Neural IS-MCTS (`nismcts.py`).** Reuse the existing IS-MCTS structure
   (determinize from observation, search), but seed the prior with the policy head and
   cut rollouts with the value head. Same encoder/net as DMC.
5. *(Optional)* **PPO self-play (`ppo.py`)** for the 2-player games, with entropy
   coeff. ~0.1 per the PG paper; report exploitability vs DMC.
6. **Export to the browser.** Keep the net small (MLP/Deep Sets, a few hundred K
   params) and export weights to JSON, then port the forward pass to TS exactly as we
   did for the linear policy — or ship via `onnxruntime-web`. The action-scorer design
   means the browser net consumes the same option features `features.ts` already
   builds.
7. **Benchmark.** Extend `h2h.mjs` / `docs/ml-benchmarks.md`: DMC vs linear vs
   IS-MCTS vs neural-IS-MCTS per game, with compute spent.

**Which converges to Nash vs. only exploits:** DMC (4), PPO self-play (5), and
neural IS-MCTS (4) are **strength-maximizers, not equilibrium solvers** — strong but
exploitable in principle. If we ever want an **unexploitable** 2-player agent, add
Deep CFR or MMD on top of the same encoder; the architecture (set encoder + per-option
scoring) is shared, so it's an add-on, not a rewrite.

---

## Status: implemented in this repo

Recommendations (1)–(3) are built in **[`packages/pyengine`](../packages/pyengine)**:
a faithful Python port of the engine (equivalence-tested against the TS engine by
diffing the full decision trace of all 8 games), plus **DMC** (`ml/dmc.py`) and
**PPO** (`ml/ppo.py`) self-play on the shared card-matrix + per-option
action-scoring network (`ml/net.py`) described in §2. Benchmarks (vs random, vs the
linear model, head-to-head) are in
**[ml-pytorch-results.md](ml-pytorch-results.md)**. The neural-guided IS-MCTS of
recommendation (2) reuses this network on top of the existing cloneable TS
`Machine`.

## Sources

- DouZero (DMC, card-game RL on one machine): [arXiv:2106.06135](https://arxiv.org/abs/2106.06135) · [PMLR v139](https://proceedings.mlr.press/v139/zha21a/zha21a.pdf)
- RLCard toolkit: [arXiv:1910.04376](https://arxiv.org/pdf/1910.04376) · [rlcard.org](https://rlcard.org/)
- NFSP: [arXiv:1603.01121](https://arxiv.org/pdf/1603.01121)
- Deep CFR: [arXiv:1811.00164](https://arxiv.org/pdf/1811.00164)
- Policy gradients competitive (7000 runs): [arXiv:2502.08938](https://arxiv.org/html/2502.08938v1) · [OpenReview](https://openreview.net/forum?id=vClBDezZUo)
- P2SRO: [arXiv:2006.08555](https://arxiv.org/abs/2006.08555) · XDO: [NeurIPS 2021](https://proceedings.neurips.cc/paper/2021/file/c2e06e9a80370952f6ec5463c77cbace-Paper.pdf)
- ReBeL (RL + search): [arXiv:2007.13544](https://arxiv.org/pdf/2007.13544)
- Determinized AlphaZero strong for imperfect info: [Frontiers in AI 2023](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2023.1014561/full)
- Permutation-invariant encoders: [Set Transformer / sensory-neuron](https://arxiv.org/pdf/2109.02869) · [exchangeable inputs](https://arxiv.org/pdf/2003.09022)
- OpenSpiel (reference impls + exploitability tooling): [GitHub](https://github.com/google-deepmind/open_spiel)
</content>
</invoke>
