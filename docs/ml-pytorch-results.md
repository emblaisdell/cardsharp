# PyTorch self-play results (DMC & PPO)

Auto-generated (--seconds 600 --games 0). Single CPU, one process per game (torch pinned to 1 thread each).

All numbers are **win rate** (shared wins count as a win), averaged over every seat orientation to cancel turn-order bias. `vs random` = one trained seat against random opponents. Head-to-head = one seat of A vs the rest filled by B.

## vs random opponents

| Game | seats | DMC | PPO | linear | random |
|---|--:|--:|--:|--:|--:|
| Blackjack | 2 | 37% | 38% | 37% | 30% |
| Go Fish | 2 | 33% | 33% | 38% | 38% |
| Old Maid | 3 | 73% | 73% | 73% | 73% |
| Thirty-One | 2 | 71% | 88% | 81% | 52% |
| The Table-less Card Game | 2 | 65% | 75% | 22% | 42% |
| The Wall | 2 | 73% | 62% | 79% | 62% |
| Crazy Bridge | 3 | 100% | 100% | 100% | 35% |
| Money Money Money | 3 | 62% | 50% | 22% | 42% |

## head-to-head (A win% / B win%)

| Game | DMC vs linear | PPO vs linear | DMC vs PPO |
|---|---|---|---|
| Blackjack | 40% / 38% | 43% / 37% | 38% / 43% |
| Go Fish | 54% / 46% | 52% / 48% | 60% / 40% |
| Old Maid | 68% / 100% | 68% / 100% | 68% / 100% |
| Thirty-One | 31% / 69% | 2% / 98% | 29% / 71% |
| The Table-less Card Game | 92% / 10% | 98% / 2% | 50% / 50% |
| The Wall | 35% / 65% | 42% / 58% | 42% / 58% |
| Crazy Bridge | 17% / 83% | 97% / 3% | 0% / 100% |
| Money Money Money | 68% / 38% | 78% / 25% | 33% / 67% |

## compute used (per method, per game)

| Game | DMC episodes / decisions / s | PPO episodes / decisions / s |
|---|---|---|
| Blackjack | 5828 / 14033 / 600s | 67584 / 163765 / 600s |
| Go Fish | 984 / 107762 / 28967s | 2352 / 260848 / 900s |
| Old Maid | 13238 / 0 / 600s | 12192 / 0 / 601s |
| Thirty-One | 5871 / 161445 / 900s | 11184 / 334338 / 902s |
| The Table-less Card Game | 794 / 637057 / 1205s | 696 / 538747 / 1222s |
| The Wall | 3025 / 277136 / 900s | 3384 / 291517 / 903s |
| Crazy Bridge | 357 / 549546 / 1202s | 240 / 302733 / 1206s |
| Money Money Money | 94 / 842347 / 1205s | 72 / 517264 / 1411s |

*DMC = Deep Monte-Carlo (DouZero-style); PPO = clipped policy gradient with entropy bonus. Both share the same card-matrix + per-option action-scoring network (`ml/net.py`). See [ml-research.md](ml-research.md) for the method rationale. Long games (Table-less, Money, Crazy Bridge, Go Fish) have hundreds–thousands of decisions per episode, so they get fewer episodes per second.*
