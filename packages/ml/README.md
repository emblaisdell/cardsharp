# @cardsharp/ml — classical-ML players

Lightweight, dependency-free strategy learning for Card# games. No neural nets:
a **linear softmax policy** over hand-crafted features, trained by **self-play
REINFORCE** (policy gradient). A trained model is a JSON weight vector of a few
dozen floats (≈1 KB) — small enough to ship to the browser and run with a dot
product.

## Why this works for any Card# game

The engine already turns every game into a sequential decision process: at each
decision point it hands a controller `(observation, legalMoves)` and resumes with
the choice; at the end each seat gets a win/loss reward. So learning a player is
just:

1. **Featurize** each legal option into a fixed-length vector φ(obs, option)
   ([features.ts](src/features.ts)) — generic features read from the observation
   (option's rank/suit/value, a target player's public card count, my hand
   size/value, turn, number of options…), so one architecture fits all games.
2. **Score & pick**: `score(option) = w · φ`; softmax to explore while training,
   argmax to play ([policy.ts](src/policy.ts)).
3. **Learn**: play self-play games, then nudge weights toward choices that led to
   wins — `w += α · (reward − baseline) · (φ_chosen − Σ_i p_i φ_i)`
   ([trainer.ts](src/trainer.ts)).

The same `MLController` is just another `Controller`, so it drops into the CLI,
the browser, or a mixed table against humans/bots.

## Usage

```bash
# train and save a model, then report win-rate vs random opponents
node packages/ml/src/main.ts train games/blackjack.card --games 4000 --out models/blackjack.json

# evaluate a saved model
node packages/ml/src/main.ts eval  games/thirtyone.card --model models/thirtyone.json --games 2000
```

## Results (win-rate vs random opponents, from one seat)

| Game | Random baseline | Trained ML | Lift |
|------|----------------:|-----------:|-----:|
| Blackjack (2p) | ~31% | ~37% | **+6** |
| Thirty-One (3p) | ~35% | ~68% | **+34** |

Lift varies by how much skill the game rewards and how well the generic features
capture it. Games dominated by hidden information or by decisions the linear
model can't see (multi-card selects, numeric ranges — handled by a random
fallback) show smaller gains; per-game feature additions in
[features.ts](src/features.ts) are the obvious next lever.

## Browser

`LinearPolicy.fromJSON(model)` + `featurizeOptions(req, obs)` are plain
TypeScript with no Node dependencies, so the web client loads a model JSON and
runs the policy inline — see `packages/web`.
