# The Table-less Card Game

*A clearer, expanded restatement of the original brief in
[custom/tableless.md](custom/tableless.md). The **Clarifications** section
records the rules this implementation uses — edit them if you meant something
different and I'll regenerate `tableless.card`.*

## Overview

A fast, standing-up game with **no table** — every card stays in players' hands.
Each round you flip progressively more cards off the top of your own deck and
race to **call the highest card showing**. Win the round and you scoop up all the
flipped cards. Run out of cards and you're out. **Last player holding a deck
wins.**

## Components & zones

| Zone | Owner | Who can see it | Notes |
|------|-------|----------------|-------|
| **deck** (`stack`) | each player | **nobody — not even the owner** | face down in hand; the deck starts split evenly among players |
| **showing** | each player | **only that player** | the top *n* cards the player has privately flipped this round |

The whole standard 52-card deck is split as evenly as possible among the players
at the start. There is no shared stock.

**Information is private.** You cannot look at your own face-down deck — only at
the cards *you* have flipped (your `showing`). And you never see another player's
flipped cards. The reveal that decides a round is resolved by the engine acting
as an impartial referee (it can read everyone's `showing` at that instant), just
like cards being turned face up in the real game; no player's view exposes
another's hand.

## How a round works

One player is the designated **counter**. Each round the counter counts up
`1, 2, 3, …`, resetting to `1` at the start of every new round.

* On the count of **n**, every player privately looks at the **top n cards** of
  their own deck (these are now "showing").
* At **any point**, any player may **call out the rank** (not suit) of a card
  they can see among their top n. The instant someone calls, the round resolves.

### Resolving a round

* The player **showing the highest-ranked card wins** (Ace is **low**).
* **Ties are broken by the call:** if the highest rank is shared, the player who
  *called* wins it.
* The winner takes **all the cards showing** across every player (that's
  `n × players` cards), shuffles them, and places them on the **bottom of their
  own deck**.
* The cards that were showing but not won are gone from their original owners
  (they went to the winner).

### The King / Ace exception

Kings are the highest rank, but **not a guaranteed win**: if the called card is a
**King**, and another player has an **odd number of Aces** (one or three)
showing, the **first such player to announce it wins the round** instead.

### Forced call

A player **must call** on the count where they flip the **last card** in their
deck (they can't keep counting with an empty deck).

## Elimination & winning

* A player is **out** when they **lose a round in which all their cards were
  showing** — i.e. they had to flip everything and didn't win, so they have no
  cards left.
* The **last player with a deck** wins.

## Clarifications (assumptions this build makes)

1. **Ace is low** for ranking; **King is high**. Rank order
   `A < 2 < … < 10 < J < Q < K`.
2. **The call timing is modeled per count step.** Real play is real-time; the
   engine discretizes it: at each count `n`, after everyone flips their nth card,
   each still-active player (in turn order from the counter) gets the option to
   call. The round resolves on the first call. This preserves "the call breaks
   ties" and "you must call when you flip your last card."
3. **Who calls / what they call:** a calling player calls the **rank of their own
   highest showing card** (calling a lower card is never advantageous, so the
   engine offers "call now" vs "keep counting," and a call announces the player's
   best showing rank).
4. **King/Ace exception priority:** when the winning call is a King, players are
   checked in turn order from the caller for an odd Ace count; the first one
   found steals the round. (Aces are low for *ranking* but this exception is
   about *holding* aces, independent of rank order.)
5. **Non-caller ties:** if a round resolves and the top rank is tied among
   players who did **not** call (can happen via the forced-call path), those
   tied players **split the showing cards** as evenly as possible; leftovers go
   to the caller.
6. **Counter** is seat 0; it doesn't affect outcomes, only the order options are
   offered in.
