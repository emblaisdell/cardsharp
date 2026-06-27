import { test } from "node:test";
import assert from "node:assert/strict";
import { GameState, RNG } from "../src/index.ts";
import type { Card } from "../src/index.ts";

// Build a small mid-game state: a shared face-down deck + per-player hands.
function mkState(): GameState {
  const s = new GameState(3, 99);
  s.defineZone({ name: "deck", perPlayer: false, visibility: "down", layout: "pile" });
  s.defineZone({ name: "hand", perPlayer: true, visibility: "owner", layout: "hand" });
  s.defineZone({ name: "table", perPlayer: false, visibility: "up", layout: "spread" });
  s.buildStandard52(s.sharedPiles.get("deck") as { cards: Card[] });
  s.rng.shuffle((s.sharedPiles.get("deck") as { cards: Card[] }).cards);
  const deck = s.sharedPiles.get("deck") as { cards: Card[] };
  for (let k = 0; k < 5; k++) {
    for (const pile of s.perPlayerPiles.get("hand") as { cards: Card[] }[]) {
      pile.cards.push(deck.cards.shift() as Card);
    }
  }
  for (let k = 0; k < 3; k++) (s.sharedPiles.get("table") as { cards: Card[] }).cards.push(deck.cards.shift() as Card);
  return s;
}

function allCardIds(s: GameState): number[] {
  const ids: number[] = [];
  for (const p of s.sharedPiles.values()) for (const c of p.cards) ids.push(c.id);
  for (const ps of s.perPlayerPiles.values()) for (const p of ps) for (const c of p.cards) ids.push(c.id);
  return ids.sort((a, b) => a - b);
}

test("clone is independent and preserves the card multiset", () => {
  const s = mkState();
  const before = allCardIds(s);
  const c = s.clone();
  // the fresh clone holds the same full 52-card multiset
  assert.deepEqual(allCardIds(c), before);
  // mutate the clone hard; the original must be untouched
  (c.sharedPiles.get("deck") as { cards: Card[] }).cards.length = 0;
  c.players[0].eliminated = true;
  assert.deepEqual(allCardIds(s), before, "original changed after mutating clone");
  assert.equal(s.players[0].eliminated, false);
});

test("determinize keeps the viewer's info and reshuffles only the unseen", () => {
  const s = mkState();
  const viewer = s.players[0];
  const myHandBefore = (s.perPlayerPiles.get("hand") as { cards: Card[] }[])[0].cards.map((c) => c.id);
  const tableBefore = (s.sharedPiles.get("table") as { cards: Card[] }).cards.map((c) => c.id);

  const d = s.determinize(viewer, new RNG(123));

  // full 52-card multiset preserved (no dupes/losses)
  assert.deepEqual(allCardIds(d), allCardIds(s));
  // the viewer's own hand is unchanged (it's information they have)
  assert.deepEqual(
    (d.perPlayerPiles.get("hand") as { cards: Card[] }[])[0].cards.map((c) => c.id),
    myHandBefore,
  );
  // the public table is unchanged (visible to everyone)
  assert.deepEqual((d.sharedPiles.get("table") as { cards: Card[] }).cards.map((c) => c.id), tableBefore);
  // hidden piles keep their COUNTS (face-down deck + opponents' hands)
  assert.equal((d.sharedPiles.get("deck") as { cards: Card[] }).cards.length,
    (s.sharedPiles.get("deck") as { cards: Card[] }).cards.length);
  for (let p = 1; p < 3; p++) {
    assert.equal((d.perPlayerPiles.get("hand") as { cards: Card[] }[])[p].cards.length, 5);
  }
});
