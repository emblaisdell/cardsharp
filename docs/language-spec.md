# The ♠# Language — Reference (v0.1)

♠# is a small, dynamically-typed scripting language with a domain library for
card games. The syntax is C-styled (braces, `//` and `/* */` comments,
C-ish operators); the semantics are card-centric.

A program is exactly one `game` declaration.

♠# is **statically (gradually) type-checked**: the compiler infers a type for
every expression and reports type errors — calling a non-function, `current.rank`
(a player has no rank), passing a number where a zone is expected, arithmetic on
a list — *before the game runs*, with line numbers. Where a type genuinely can't
be known (an untyped function parameter) it is `any`, which is compatible with
everything, so you are never forced to annotate. See §10.

---

## 1. Lexical structure

* **Comments:** `// line` and `/* block */`.
* **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`.
* **Numbers:** integer or decimal (`7`, `3.5`). All numbers are doubles.
* **Strings:** `"double quoted"`, with `\n \t \" \\` escapes.
* **Keywords:** `game players deck zone var function setup flow
  score winners if else while for in loop repeat break continue return
  true false null per up down owner`.
* **Operators:** `+ - * / % == != < <= > >= && || ! = => ? : .. .` and
  `( ) [ ] { } , ;`.

---

## 2. Values & types

| Type | Notes |
|---|---|
| `number` | doubles; `7`, `3.5` |
| `bool` | `true`, `false` |
| `string` | `"text"` |
| `null` | absence |
| `card` | `{ rank, suit, value, id }` (see below) |
| `player` | a participant handle |
| `zone` | a card pile handle (shared or per-player) |
| `list` | ordered sequence of any values; `[1, 2, 3]` |
| `function` | named functions and `=>` lambdas |
| `record` | `{ key: value }` map literal (rarely needed) |

### Cards

A card has:

* `.rank` — integer `1..13` (`1`=Ace, `11`=Jack, `12`=Queen, `13`=King).
* `.suit` — integer `0..3` (`0`=Clubs, `1`=Diamonds, `2`=Hearts, `3`=Spades).
* `.value` — numeric value used by the game, set by the `deck`/`values` config
  (defaults to the rank; e.g. Blackjack and The Wall override it).
* `.id` — a stable hidden identity used for tracking/animation; never shown for
  hidden cards.
* `.color` — `"red"` for Diamonds/Hearts, `"black"` for Clubs/Spades.
* `.rankName`, `.suitName` — display strings.

Rank/suit constants are available as builtins: `Ace Jack Queen King`,
`Clubs Diamonds Hearts Spades`, and the lists `ranks` (1..13) and `suits` (0..3).

**Unicode suits.** The glyphs `♣ ♦ ♥ ♠` are first-class suit constants,
interchangeable with the names: `c.suit == ♥` means the same as
`c.suit == Hearts`. A card also exposes `.glyph` (its suit glyph as a string).

---

## 3. Program structure

```c
game "Name" {
    players 2..6;          // exact "players 4;" or range "players 2..6;"
    deck    standard52;    // builtin deck; or: deck custom { ... } (see §7)

    zone <name> : <spec>;  // zero or more zone declarations
    var  <name> = <expr>;  // game-global variables

    setup { <statements> }     // runs once after deck creation
    flow  { <statements> }     // the game driver; runs once

    function <name>(<params>) { <statements> }   // helpers

    score   <param> => <expr>;     // per-player value, HIGHER IS BETTER (may be <0)
    winners => <expr>;             // optional override; a player or list of players
}
```

Order of sections is free. `setup` runs, then `flow` runs to completion. The game
ends when `flow` returns/falls off the end, when `endGame()` is called, or when
the engine detects a single remaining active player.

### Score and winners

`score` is the canonical per-player value: **higher is better**, and it may be
negative (negate a penalty for golf-scored games like Crazy Bridge). The engine
resolves the winner(s) in this priority order:

1. an explicit `declareWinner(p)` / `declareWinners(list)` call made during play
   (use this for odd cases — e.g. Blackjack, played against the dealer, where
   *nobody* may win);
2. an explicit `winners => <expr>;` declaration;
3. **the default: the player(s) with the maximum `score`, ties included.**

So most games just declare `score` and omit `winners` entirely. For elimination
games, define `score` so the losers rank below the winners (e.g. eliminated
players naturally have 0 lives / an empty pile). Because `score` is a real
higher-is-better value, it doubles as the **value heuristic for tree search**
(`packages/ml` MCTS can evaluate it at a depth cutoff instead of playing out).

### Zone specifications

```
zone pond  : pile;                 // shared, ordered, face down
zone hand  : pile per player;      // one per player, visible to its owner
zone books : pile per player up;   // one per player, visible to everyone
zone table : pile up;              // shared, face up
```

A zone spec is a **layout** keyword followed by optional modifiers:

* layout — `pile`/`stack` render collapsed (top card + a stack effect + a `×N`
  count, expandable in the UI); `hand`/`fan`/`spread` render fully laid out. This
  is a **rendering hint only** — it has no effect on game logic. (A private hand
  the viewer can't see is drawn as a fan sized to its card count.)
* `per player` — instantiates one independent pile per player, indexed
  `name[player]`. Without it, the zone is a single shared pile referenced by
  `name`.
* visibility — `up` (everyone sees), `down` (no one sees; default for shared),
  `owner` (only the owning player sees; default for `per player`).

```
zone pond  : pile;                 // shared, collapsed, face down
zone hand  : hand per player;      // one per player, owner sees, fully spread
zone books : spread per player up; // public, fully visible
zone draw  : stack;                // collapsed, with a ×N marker
```

Visibility controls what the engine reveals in each player's *observation*
(§6) — it does not restrict what game code can read.

---

## 4. Statements

```c
var x = expr;                 // declare local (or game-global at top level)
x = expr;                     // assign existing variable
if (cond) { ... } else { ... }
while (cond) { ... }
for (c in coll) { ... }       // iterate a list
loop { ... }                  // infinite loop; use break
repeat (n) { ... }            // run body n times
break;  continue;
return expr;                  // return from a function
expr;                         // expression statement (usually a call)
```

Blocks introduce a new scope. Lambdas close over their enclosing scope.

---

## 5. Expressions

* Literals, identifiers, list literals `[a, b, c]`, record literals `{k: v}`.
* Member access `card.rank`, `player.id`.
* Indexing `list[i]`, and per-player zone access `hand[player]`.
* Calls `f(a, b)`; lambdas `x => x.rank` and `(a, b) => a + b`.
* Unary `!x`, `-x`. Binary `* / % + -  < <= > >=  == !=  && ||`.
* Ternary `cond ? a : b`. Range `a..b` (used in `players` and as a list builder).
* `&&`/`||` short-circuit; `==` compares cards by identity, numbers/strings by
  value.

---

## 6. Decision points (the choice model)

The engine never decides anything. Game code asks the acting player to choose,
and the call **suspends** until a controller (human, bot, or ML agent) answers.
There is exactly **one** decision primitive:

```c
choose(who, options, prompt)   -> one of options
```

* `who` is the deciding player.
* `options` is the legal set — a list of *any displayable values*. The controller
  may only return a member of it (the engine validates).
* `choose` returns the chosen option.

**Options can be anything displayable**, and how each option renders is derived
from its own runtime value — there is no per-call "kind". A `card` draws as a
card, a `player` as its name, a `list` (e.g. a meld) as its cards, a `bool` as
Yes/No, a `string`/`number` as itself:

```c
choose(p, cards(hand[p]), "Discard")          // card
choose(p, others(p), "Attack whom?")          // player
choose(p, [true, false], "Hit?")              // bool  (Yes / No buttons)
choose(p, findMelds(cards(hand[p])), "Meld?") // list  (a meld)
```

**Declining (`Option<T>`).** Include `null` among the options: it renders as a
**"None"** button and `choose` returns `null` if picked. So "play a card, or
stop" is one decision, not a card-choice plus a separate boolean. In `Option<T>`
terms `null` is `None` and every other option `t` is `Some(t)` that displays as
`t` — there is no wrapper to unwrap:

```c
var card = choose(p, concat(cards(hand[p]), [null]), "Play a card, or stop");
if (card == null) { /* declined */ }
```

**Custom labels — `labeled(value, text)`.** To control how an option displays
without changing the value `choose` returns, wrap it: `labeled(value, text)`
shows `text` but `choose` returns the underlying `value`. It is transparent to
the type system (its static type is the wrapped value's type). This is how a
rank choice shows "Jack" yet returns the number `11`, and how the decline button
can be renamed:

```c
var rank = choose(p, map(ranks, r => labeled(r, rankName(r))), "Ask which rank?");
// rank : num   (UI showed "Jack", "Queen", …)
choose(p, concat(cards(hand[p]), [labeled(null, "Stop")]), "Play, or stop");
```

`rankName(n)` / `suitName(n)` give the display name of a bare rank/suit number.

Because every branch point is an explicit, enumerated choice, the same game is
directly usable as a turn-based multiplayer protocol and as an ML environment: at
each step the engine yields `{ player, observation, options }` and resumes with
the chosen value. A choice with a single legal option is auto-resolved.

> **Note.** Range and multi-select choices fold into the same primitive: a
> numeric pick is `choose(who, range(lo, hi), prompt)`, and selecting a subset is
> `choose` over a list whose options are the candidate subsets (each a list).

A player only ever sees an observation consistent with zone visibility (§3): the
contents of zones they cannot see are replaced by face-down placeholders.

---

## 7. Builtin library (standard deck domain)

**Players & turns**

```
players                      // list of all players (also the count via count())
current                      // the current player (set by turn helpers)
others(p)                    // all players except p, in turn order from p
active(), activePlayers      // players not yet eliminated
nextPlayer(), endTurn()      // advance `current` to the next active player
setCurrent(p)
eliminate(p), isActive(p)
declareWinner(p), declareWinners(list), endGame()
turnIndex()                  // 0-based count of turns taken
```

**Zones & movement**

```
size(zone)                   // number of cards
cards(zone)                  // list of cards (order = top..bottom)
top(zone, n=1), bottom(zone, n=1)     // list of the top/bottom n cards
shuffle(zone)
deal(from, to, n)            // move n from `from` to each player's `to` (per-player)
                             //   or n total if `to` is a shared zone
move(cards, toZone)          // move specific cards to a zone (top)
moveTo(cards, toZone, "bottom")
draw(from, to, n=1)          // move n from top of `from` to `to`
```

**Collections / functional**

```
count(list)                  count(list, pred)
filter(list, pred)   map(list, fn)   sortBy(list, key)   reverse(list)
any(list, pred)   all(list, pred)   none(list, pred)
sum(list, key?)   max(list, key?)   min(list, key?)   maxBy/minBy(list, key)
first(list)   last(list)   take(list, n)   drop(list, n)   concat(a, b)
contains(list, x)   unique(list)   range(a, b)
groupBy(list, key)           // -> record of key -> list
```

**Card helpers**

```
ranksOf(list)   suitsOf(list)        // unique ranks/suits present, sorted
sameRank(list)  sameSuit(list)       // bool: all share rank / suit
isRun(list, wrap?)                   // contiguous ranks (wrap at Ace if wrap)
valueOf(card)   handValue(list)      // sum of .value
rankName(n)     suitName(n)          // display name of a bare rank/suit number
playersWithMax(key)  playersWithMin(key)
```

**Decisions**

```
choose(who, options, prompt)         // the sole decision primitive (see §6)
labeled(value, text)                  // an option that displays as `text` but
                                      //   resolves to `value`
```

**Misc**

```
log(...)        // debug output (suppressed in networked play)
rng()           // deterministic [0,1); seeded per game
abs min max floor ceil round
```

---

## 8. Determinism

All randomness flows through the game's seeded RNG (`shuffle`, `rng()`). Given a
seed and the sequence of controller choices, a game replays identically on every
machine. This is the contract the WebRTC layer and the ML replay buffer rely on.

---

## 9. Example: a complete minimal game

```c
game "High Card" {
    players 2;
    deck standard52;
    zone deck : pile;
    zone up   : pile per player up;

    setup { shuffle(deck); deal(deck, up, 1); }

    flow {
        // no decisions: pure chance
        endGame();
    }

    winners => playersWithMax(p => first(cards(up[p])).rank);
}
```

---

## 10. The type system

Types: `num bool str null card player pile family record list<T> fn(...)->T`,
plus `any` (gradual escape hatch) and `void`.

* **Inference, not annotations.** `var n = size(pond) + 1` gives `n : num`;
  `var t = filter(others(current), p => size(hand[p]) > 0)` gives
  `t : list<player>`. Lambda parameter types flow *in* from the builtin being
  called — in `filter(cards(hand[p]), c => c.rank == 4)`, `c` is known to be a
  `card`, so `c.suitz` is a compile error.
* **`pile` vs `family`.** A shared zone is a `pile`; a `per player` zone is a
  `family` that must be indexed (`hand[p] : pile`). `size(hand)` is a type error
  ("per-player zone must be indexed"); `size(hand[p])` is fine.
* **`any` is compatible with everything**, both ways. Untyped function
  parameters are `any`, so helper functions stay terse; the trade-off is less
  checking inside them.
* **What it catches:** unknown names, calling a non-function, wrong argument
  count/type to a builtin, bad member access (`current.rank`), indexing a
  non-list, arithmetic on non-numbers, `for-in` over a non-list, returning the
  wrong type from `score`/`winners`.

Run it standalone with `cardsharp check game.card`, or rely on `compile()` /
`runGame()` which type-check by default (pass `{ typecheck: false }` to skip).
The VSCode extension surfaces the same diagnostics inline.

---

This document tracks the implementation in `packages/core`. Where the two
disagree, the implementation's tests are authoritative until this spec is
updated.
