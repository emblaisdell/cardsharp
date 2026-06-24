import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runGame, RandomController, FirstController } from "../src/index.ts";

const gofish = readFileSync(
  fileURLToPath(new URL("../../../games/gofish.card", import.meta.url)),
  "utf8",
);

test("expression evaluation via a tiny game", async () => {
  const src = `game "Calc" {
    players 1;
    var result = 0;
    flow {
      result = 1 + 2 * 3;              // 7
      if (result == 7) { result = result + (isRun([1,2,3]) ? 100 : 0); }
      endGame();
    }
    winners => players;
  }`;
  // 1 player, no choices: just make sure it runs and the math is right.
  const res = await runGame(src, [new FirstController()], { players: 1, quiet: true });
  assert.equal(res.state.globals.get("result"), 107);
});

test("isRun handles ace wrapping (QKA23)", async () => {
  const src = `game "Run" {
    players 1;
    var a = 0; var b = 0;
    flow {
      a = isRun([12,13,1,2,3], true) ? 1 : 0;   // wrap -> true
      b = isRun([12,13,1,2,3], false) ? 1 : 0;  // no wrap -> false
      endGame();
    }
    winners => players;
  }`;
  const res = await runGame(src, [new FirstController()], { players: 1, quiet: true });
  assert.equal(res.state.globals.get("a"), 1);
  assert.equal(res.state.globals.get("b"), 0);
});

test("Go Fish runs to a terminal state for many seeds", async () => {
  for (let seed = 0; seed < 50; seed++) {
    const controllers = [0, 1, 2].map((i) => new RandomController(seed * 10 + i));
    const res = await runGame(gofish, controllers, { players: 3, seed, quiet: true });
    // game must end with every card accounted for (52 total across all zones)
    let total = 0;
    for (const pile of res.state.sharedPiles.values()) total += pile.cards.length;
    for (const piles of res.state.perPlayerPiles.values())
      for (const p of piles) total += p.cards.length;
    assert.equal(total, 52, `seed ${seed}: expected 52 cards, found ${total}`);
    assert.ok(res.winners.length >= 1, `seed ${seed}: expected at least one winner`);
  }
});

test("controllers may only choose legal options", async () => {
  // A controller that returns an illegal value must be rejected by the engine.
  const Bad = {
    choose() {
      return 999; // never a legal player/rank
    },
  };
  await assert.rejects(
    runGame(gofish, [Bad, Bad, Bad], { players: 3, quiet: true }),
    /illegal/,
  );
});
