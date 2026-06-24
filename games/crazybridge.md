# Crazy Bridge (assumed ruleset)

You described Crazy Bridge as **"a standard-deck precursor to Phase 10."** That
places it in the **Contract / Liverpool / Progressive Rummy** family, which is
exactly the lineage Phase 10 commercialized. The public name "Crazy Bridge" also
attaches to an unrelated trick-taking party game; I am **ignoring that** and
implementing the progressive-contract-rummy game you described.

This file is the spec I'm coding to. **If any of it is wrong, edit this file and
I'll regenerate `crazybridge.card` to match** — same workflow as the three custom
games.

## Players & deck

* 2–6 players.
* Two standard 52-card decks shuffled together (104 cards) for 4+ players; one
  deck for 2–3. (Phase-10 precursors use a double deck so runs/sets are
  reachable.) *Assumption — tell me if it's a single deck.*

## Structure

* The game is a fixed sequence of **deals (rounds)**, each with a required
  **contract** the player must lay down before they can go out. Everyone plays
  the same contract in a given round.

| Round | Contract |
|------:|----------|
| 1 | two sets of 3 (2 books) |
| 2 | one set of 3 + one run of 4 |
| 3 | two runs of 4 |
| 4 | three sets of 3 |
| 5 | two sets of 3 + one run of 4 |
| 6 | one set of 3 + two runs of 4 |
| 7 | three runs of 4 (go out, no discard) |

*(Assumption: 7 rounds, the classic Liverpool sequence. Phase 10 uses 10. Tell
me which you want.)*

* **Set** = N cards of equal rank (suit irrelevant). **Run** = N cards of one
  suit in consecutive rank. (Ace high or low; no wrap unless you say so.)

## A turn

1. **Draw** — take the top of the stock, **or** take the top of the discard pile.
2. **Lay down** — if you are holding the round's full contract and have not laid
   down yet, you may meld it face-up in front of you.
3. **Lay off** — once you've laid down, you may add cards to *anyone's* melds.
4. **Discard** one card to the discard pile (ending your turn). Going out =
   discarding your last card after having laid down.

## Buying (out of turn) — **enabled**

When a player discards, the card is offered before the next player draws:

1. The **next player to act** has first right to it as their *normal* draw —
   they take it for free (no penalty) and it becomes their turn.
2. If they don't want it, any **other** player may **buy** it: they take the
   discarded card **plus one penalty card** off the top of the stock (net +2 to
   their hand). Buying does **not** give them a turn — play still passes to the
   next player in order.
3. If several players want to buy, priority goes to the one **nearest in turn
   order** after the discarder.
4. **No cap on buys**, except in the **final round**, where each player may buy
   at most **2 times**.

Mechanically, after every discard the engine offers the top discard to each
non-current player in turn order (a `chooseBool` "buy?" decision; in the final
round a player is skipped once they've used their 2 buys), then proceeds to the
next turn.

## Scoring

* When a player goes out, the round ends and everyone scores **penalty points**
  for cards still in hand: number cards = face value, J/Q/K = 10, Ace = 15.
* Lowest cumulative score after the last round **wins** (it's a golf-style
  low-score-wins game).

## Open questions (defaults in brackets)

1. One deck or two? [two for 4+].
2. How many rounds / exact contract ladder? [7-round Liverpool ladder above].
3. Ace high, low, or both in runs? [both, no wrap].
4. ~~Buying from the discard pile out of turn?~~ **Resolved: enabled** (see
   "Buying" above) — unlimited buys, except **2 buys/player in the final round**.

Resolved per your instruction (buying on); all other questions keep the
bracketed defaults.
