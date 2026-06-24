# Money Money Money

*A clearer, expanded restatement of the original brief in
[custom/money3.md](custom/money3.md). Where the original was ambiguous, the
**Clarifications** section records the rule this implementation uses — edit those
if you meant something different and I'll regenerate `moneymoneymoney.card`.*

## Overview

A turn-based game of building a hidden **money pile**. You play melds from your
hand onto a face-down pile nobody is allowed to look at; bigger melds earn bonus
cards. When the draw deck runs dry everyone chips in from their pile to refill
it, and anyone whose pile is empty at that moment is knocked out. **Outlast
everyone — the last player standing wins.**

## Components & zones

| Zone | Owner | Who can see it | Notes |
|------|-------|----------------|-------|
| **hand** | each player | only the owner | starts at 5 cards |
| **money pile** | each player | **nobody** (not even the owner) | face down; the owner may shuffle it anytime |
| **draw deck** | table | nobody | the stock everyone draws from |
| **center** | table | nobody | scratch area used only during a replenish |

The money pile being invisible *even to its owner* is the defining mechanic: you
know how many cards you have, never which.

## Setup

1. Shuffle a standard 52-card deck.
2. Deal **5 cards** to each player's hand.
3. The rest becomes the draw deck. All money piles start empty.

## A turn

**1. Draw** — based on your *current hand size*:

| Hand size | Cards drawn |
|-----------|-------------|
| ≤ 5 | 2 |
| 6 – 15 | 1 |
| > 15 | 0 |

**2. Play melds** — play as many melds as you like, in any order. A **meld** is
one of:

* a **book** — 2+ cards of the **same rank**, different suits;
* a **run** — 2+ cards of the **same suit** in consecutive rank, **wrapping at
  the Ace** (so `K-A-2` is legal, and `Q-K-A-2-3` is a valid run of 5);
* a **single** — any one card (a trivial meld of size 1).

Playing a meld of size **n**:

* The cards leave your hand and go **face down onto your money pile**.
* If **n = 1**: that's all — the card is stashed privately.
* If **n ≥ 2**: you first **reveal the meld to everyone**, then it goes face down
  onto your money pile, and you immediately take **n·(n−1) bonus cards** off the
  draw deck straight onto your money pile (**nobody looks** at them).

  | Meld size n | Bonus cards |
  |---|---|
  | 2 | 2 |
  | 3 | 6 |
  | 4 | 12 |
  | 5 | 20 |

**3. End your turn** — play passes to the next player.

At any time on any turn, a player may **shuffle their own money pile**.

## Running out of cards — replenish

A replenish happens the moment the draw deck **is empty, or would be emptied** by
a draw or a bonus payment. Then:

1. Any player whose money pile is **empty** is **eliminated**.
2. Let **m** = the smallest money-pile size among the remaining players.
3. Each remaining player moves **m cards from the top of their money pile** into
   the center.
4. The center cards **plus** whatever was left of the draw deck are shuffled
   together to form the **new draw deck**.
5. Play resumes.

## Winning

The **last player remaining** wins (everyone else has been eliminated at a
replenish).

## Clarifications (assumptions this build makes)

1. **"Value" for a book means rank** (Ace…King); books are same-rank, distinct
   suits.
2. **Runs wrap once** through the Ace; a run can't reuse a rank, so max length 13.
3. **Drawing uses hand size at the start of the turn**, before any cards are
   drawn that turn.
4. **Bonus is paid per meld**, using the size of that meld (not cumulative).
5. **Replenish elimination order:** empties are removed *first*, then **m** is
   computed over the survivors, then everyone contributes. A player reduced to an
   empty pile by contributing is *not* retroactively eliminated this round — they
   get knocked out at the *next* replenish if still empty.
6. **"Last to be eliminated wins"** is implemented as **last player standing
   wins** (the survivor). If a replenish would eliminate everyone simultaneously,
   the player(s) with the largest pile just before it are the winners.
7. **Bot meld choice:** because random subsets rarely form legal melds, the
   engine enumerates the legal melds available from a hand (all books, all
   maximal runs, every single) and the controller picks one or chooses to stop.
