import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile, GameState, RNG } from "../src/index.ts";
import { playIsmctsGame } from "../../ml/src/ismcts.ts";

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../games/${name}`, import.meta.url)), "utf8");
}

// Smoke test: fair IS-MCTS runs to completion on real games and returns valid
// winners — exercising clone + determinize + depth-limited score-rollouts. Kept
// to low iteration counts so it stays fast.
for (const [file, seats] of [["blackjack.card", 2], ["gofish.card", 3], ["thewall.card", 2]] as const) {
  test(`${file}: fair IS-MCTS plays a legal game`, () => {
    const program = compile(read(file));
    for (let g = 0; g < 2; g++) {
      const winners = playIsmctsGame(
        program,
        new GameState(seats, 500 + g),
        0,
        { iterations: 15, rolloutDepth: 12 },
        new RNG(3 + g),
      );
      // every winner is a real seat; the result is a (possibly empty) array
      assert.ok(Array.isArray(winners));
      for (const p of winners) assert.ok(p.id >= 0 && p.id < seats);
    }
  });
}
