# ♠# / CardSharp

**A domain-specific language for standard 52-card deck games**, with a portable
interpreter, browser-based WebRTC multiplayer, and a lightweight classical-ML
strategy learner.

♠# (written `CardSharp` where `#` is awkward) lets you describe a card game —
its zones, its turn flow, its legal moves, and its win conditions — in a compact
C-styled language. One interpreter then runs that game anywhere: in a terminal,
in the browser against friends over WebRTC, or inside a self-play loop that
trains an agent to play it well.

```c
// Go Fish, in ♠#
game "Go Fish" {
    players 2..6;
    deck    standard52;

    zone pond  : pile;                 // the draw deck (shared, face down)
    zone hand  : pile per player;      // each player's hand (owner-visible)
    zone books : pile per player up;   // completed four-of-a-kinds (public)

    setup {
        loadDeck(pond);                    // materialize the 52 cards
        shuffle(pond);
        deal(pond, hand, count(players) <= 3 ? 7 : 5);
    }

    flow {
        loop {
            var target = choosePlayer(current, others(current),
                                      "Ask whom?");
            var rank = chooseRank(current, ranksOf(cards(hand[current])),
                                  "Ask for which rank?");
            var got = filter(cards(hand[target]), c => c.rank == rank);

            if (count(got) > 0) {
                move(got, hand[current]);
            } else if (size(pond) > 0) {           // "Go fish"
                move(top(pond, 1), hand[current]);
            }

            collectBooks(current);
            if (gameOver()) break;
            endTurn();
        }
    }

    function collectBooks(p) {
        for (r in ranksOf(cards(hand[p]))) {
            var set = filter(cards(hand[p]), c => c.rank == r);
            if (count(set) == 4) move(set, books[p]);
        }
    }

    function gameOver() {
        return size(pond) == 0 && all(players, p => size(hand[p]) == 0);
    }

    score   p => count(cards(books[p])) / 4;
    winners => playersWithMax(p => score(p));
}
```

---

## Why a DSL?

The eight reference games in this repo (Go Fish, Old Maid, Crazy Bridge,
Thirty-One, Blackjack, and the three custom games **Money Money Money**,
**The Table-less Card Game**, and **The Wall**) share almost nothing at the
surface — trick-taking, melding, simultaneous reveals, targeted attacks,
elimination — yet they all reduce to the same handful of primitives:

* **Cards** with a rank, a suit, and a configurable numeric value.
* **Zones** — named collections of cards with ownership and visibility.
* **Moves** — transfers of cards between zones, chosen by a player from a set of
  legal options at a *decision point*.
* **Flow** — the order in which decision points are offered.
* **Terminal & scoring** rules that decide who wins.

Modeling games as *"the engine enumerates legal moves at each decision point;
a controller picks one"* is what makes the same description reusable for a human
clicking in a browser, a random bot, and an ML agent exploring a game tree.

See **[docs/language-spec.md](docs/language-spec.md)** for the full language
reference and **[docs/architecture.md](docs/architecture.md)** for how the pieces
fit together.

---

## Repository layout

```
cardsharp/
├── README.md
├── docs/
│   ├── language-spec.md        # ♠# grammar + builtin reference
│   └── architecture.md         # how interpreter / net / ML connect
├── games/                      # game implementations (.card) + ruleset notes (.md)
│   ├── gofish.card
│   ├── oldmaid.card
│   ├── blackjack.card
│   ├── thirtyone.card
│   ├── crazybridge.card        + crazybridge.md   (clarified ruleset)
│   ├── moneymoneymoney.card    + moneymoneymoney.md
│   ├── tableless.card          + tableless.md
│   ├── thewall.card            + thewall.md
│   └── custom/                 # the original briefs, verbatim
│       ├── money3.md
│       ├── tableless.md
│       └── thewall.md
└── packages/
    ├── core/                   # the ♠# language (no deps, runs anywhere)
    │   ├── src/lexer.ts
    │   ├── src/parser.ts
    │   ├── src/ast.ts
    │   ├── src/values.ts       # Card / Zone / List / Player value types
    │   ├── src/state.ts        # game state + visibility
    │   ├── src/interpreter.ts  # generator-based, yields ChoiceRequests
    │   ├── src/builtins.ts     # standard library
    │   ├── src/controllers.ts  # random / scripted / (pluggable) controllers
    │   ├── src/engine.ts       # load + run a game to completion
    │   └── test/               # unit + self-play smoke tests
    ├── cli/                    # `cardsharp run games/gofish.card`
    ├── web/                    # static WebRTC client (no server-side game logic)
    ├── server/                # minimal signaling / matchmaking server
    └── ml/                     # classical self-play strategy learner
```

---

## Status & roadmap

| Component | Status |
|---|---|
| Language spec | ✅ `docs/language-spec.md` |
| Lexer / parser / AST | ✅ implemented |
| **Static type checker** (errors before runtime) | ✅ implemented + tested |
| **Unicode suit glyphs** (`♣ ♦ ♥ ♠`) | ✅ implemented |
| Interpreter + stdlib (generator/choice model) | ✅ implemented |
| CLI (`run` / `check` / `tokens` / `ast`) | ✅ implemented |
| **VSCode extension** (highlighting + live diagnostics) | ✅ installed |
| Test suite (lexer/parser/checker/interpreter/self-play) | ✅ 19 tests |
| **All 8 games** (Go Fish, Old Maid, Blackjack, Thirty-One, Crazy Bridge, Money Money Money, Table-less, The Wall) | ✅ implemented, type-checked, regression-tested |
| Classical-ML self-play trainer + agents | ✅ linear policy-gradient (`packages/ml`), +6 to +34 pt lift |
| Browser version (static, local play vs bots/ML) | ✅ zero-dep bundle (`packages/web`) |
| WebRTC multiplayer + signaling/matchmaking server | 🔜 last |

Legend: ✅ done · 🔜 planned next.

Try it:

```bash
node packages/cli/src/main.ts run   games/blackjack.card --players 3 --seed 5
node packages/cli/src/main.ts run   games/oldmaid.card  --players 4 --games 300 --quiet
node packages/cli/src/main.ts check games/gofish.card
node --test 'packages/core/test/*.test.ts'
node tools/vscode-cardsharp/install.mjs   # install editor support
```

### Implementation phases

1. **Language core** — primitives, parser, interpreter, choice model. *(done)*
2. **Game coverage** — implement all eight games; every new game that needs a
   primitive the language lacks is a signal to extend the language, not to
   special-case the game. This is the language's correctness test.
3. **Multiplayer** — the interpreter runs *locally on each peer*; peers stay in
   sync because the game is deterministic given a shared RNG seed and the
   sequence of chosen moves. The server only does matchmaking + WebRTC signaling
   (offer/answer/ICE relay); it never sees game logic. Fully static client.
4. **ML** — because the engine exposes `(observation, legalMoves)` at every
   decision point and a terminal reward, a game is a sequential decision process.
   Start with tabular/linear methods over hand-rolled features
   (Monte-Carlo control, linear TD), exportable as a tiny JSON weight vector the
   browser loads — no heavyweight runtime in the client.

---

## Running it

No build step is required — the core runs on Node 22+ native TypeScript.

```bash
# play / simulate a game with random bots
node packages/cli/src/main.ts run games/gofish.card --players 3 --seed 1

# run the test suite
node --test packages/core/test/
```

(Convenience `npm` scripts are wired in `package.json`.)

---

## Design principles

* **The language is the spec.** A game's `.card` file is the single source of
  truth; the same bytes run in the terminal, the browser, and the trainer.
* **Decisions are first-class.** The engine never picks a move; it presents legal
  moves to a controller. Humans, bots, and ML agents are all just controllers.
* **Visibility is modeled, not bolted on.** Each zone declares who can see it, so
  the engine can hand each player a correct, information-hiding observation —
  essential for honest multiplayer and for imperfect-information ML.
* **Determinism by seed.** Given a seed and the move sequence, a game replays
  identically everywhere. This is what makes static-hosted P2P multiplayer and
  reproducible training possible.
* **Stay portable.** The core has zero runtime dependencies.
