# The Wall

*A clearer, expanded restatement of the original brief in
[custom/thewall.md](custom/thewall.md). The **Clarifications** section records
the rules this implementation uses — edit them if you meant something different
and I'll regenerate `thewall.card`.*

## Overview

Each **suit does what it looks like.** You hoard **diamonds** (treasure), defend
them behind a wall of **hearts** (health), and attack rivals with **spades** (dig
under the wall to steal diamonds) and **clubs** (smash the wall directly). When
the deck runs out and everyone's hands are empty, **the most diamonds wins.**

## The four suits

| Suit | Role | Effect when played |
|------|------|--------------------|
| ♦ Diamonds | **treasure** | placed in front of you; their sum decides the winner |
| ♥ Hearts | **the wall (health)** | placed in front of you; they absorb club damage and gate spade theft |
| ♠ Spades | **steal** (attack) | target a rival; **steal diamonds** from them up to the spade's value |
| ♣ Clubs | **smash** (attack) | target a rival; **destroy hearts** (wall) up to the club's value |

## Card value

Every card has a numeric value: the pip number for `2–10`, **10** for face cards
(J/Q/K), and **11** for Aces (Aces are **not** 1 here).

## Zones

| Zone | Owner | Visibility |
|------|-------|------------|
| **hand** | each player | owner only — starts at 7 cards |
| **diamonds** | each player | public (face up in front of you) |
| **wall** (hearts) | each player | public |
| **draw deck** | table | hidden |
| **discard** | table | public |

## A turn

Turns always proceed in the **same fixed order**.

1. **Draw 2** cards from the deck at the start of your turn (see end-game changes
   below).
2. **Play 0–3 cards**, in any order:
   * **Diamond or heart (resource):** placed in front of you (into your diamonds
     or your wall).
   * **Spade or club (attack):** choose a **target** rival; resolve as below.
3. **End your turn.** You may choose to stop early **only while holding ≤ 7
   cards.** There is **no discarding** — if you're still above 7 you are not
   offered the option to stop, so you must keep playing (up to the 3-card limit)
   until you're at 7 or fewer. Because you start the turn at ≤ 7 and draw only 2,
   three plays is always enough to get back to ≤ 7.

### Resolving an attack — the No-Change Rule

An attack card has a numeric value. The **defender** must give up a set of cards
of the appropriate suit whose **values sum to at least the attack value** — the
defender chooses *which* cards:

* **Spade (steals diamonds):** the defender hands over a set of **diamonds**
  summing to ≥ the spade's value. Those diamonds go to the **attacker**.
* **Club (smashes the wall):** the defender gives up **hearts** summing to ≥ the
  club's value. Those hearts go to the **discard** (destroyed).

There is **no change / no overflow:** the defender picks the smallest legal set
they wish, but if their total in that suit is **less than** the attack value,
they must surrender **all** of it (and no more — a club that over-kills the wall
does **not** spill over into diamonds).

* **Special — clubbing a wall-less player:** if a club is played at a player who
  has **no wall (no hearts)**, the attack bypasses defense and **all of that
  player's diamonds go to the attacker.**

## End game

* Once the **draw deck is empty**, players stop drawing. On your turn you must
  now **play at least one card** from your hand (the very last drawer may draw
  the single remaining card if exactly one is left).
* If you have **no cards in hand at the start of your turn**, you are **skipped**.
* The game **ends** when the draw deck is empty **and** no player has any cards
  left in hand.

## Winning

The winner is the player with the **largest sum of diamond values** in front of
them.

## Clarifications (assumptions this build makes)

1. **Attack value = the played card's value** (face 10, Ace 11), same scale as
   the resources being surrendered.
2. **Defender surrenders the cheapest legal set:** the engine automatically
   gives up the qualifying set with the **smallest total value** (minimal
   overflow) — so the defender never loses more than required — or everything if
   the suit can't reach the attack value. This is computed exactly, not greedily.
3. **Spades vs. a diamond-less player:** a spade simply steals nothing (there are
   no diamonds to take). Only the **club**-vs-wall-less special case redirects to
   diamonds, per the brief.
4. **Targets** are chosen by the attacker among the other players; self-targeting
   is not allowed.
5. **"Play 0–3 cards"** is enforced per turn. There is **no discarding**: the
   hand-size-≤7 limit is enforced by *gating the option to stop* — you only get
   the choice to end your turn once you hold ≤ 7 cards. Since you draw just 2 and
   start ≤ 7, the 3-card cap always lets you reach ≤ 7, so it never traps you
   above the limit.
6. **Deck-empty "must play one":** if a player has cards but the only legal thing
   is to play a resource, that still satisfies the requirement. A player with an
   empty hand is skipped; the game ends when all hands are empty.
