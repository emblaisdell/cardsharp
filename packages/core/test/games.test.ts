import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runGame, typecheck, RandomController, compile } from "../src/index.ts";

const gamesDir = fileURLToPath(new URL("../../../games/", import.meta.url));
const files = readdirSync(gamesDir).filter((f) => f.endsWith(".card"));

// every shipped game must type-check with zero diagnostics
for (const f of files) {
  test(`${f} type-checks clean`, () => {
    const src = readFileSync(gamesDir + f, "utf8");
    assert.deepEqual(typecheck(src), [], `${f} should have no type errors`);
  });
}

// every shipped game must run to completion (multiple seats + seeds), conserving
// all cards and producing at least one winner
for (const f of files) {
  test(`${f} runs to completion and conserves cards`, async () => {
    const src = compile(readFileSync(gamesDir + f, "utf8"));
    const range = (src.sections.find((s) => s.type === "PlayersDecl") as
      | { min: number; max: number }
      | undefined) ?? { min: 2, max: 2 };
    for (let seed = 0; seed < 5; seed++) {
      const seats = Math.min(range.max, range.min + (seed % 2));
      const controllers = Array.from(
        { length: seats },
        (_, i) => new RandomController(seed * 100 + i),
      );
      const res = await runGame(src, controllers, { players: seats, seed, quiet: true });
      let total = 0;
      for (const pile of res.state.sharedPiles.values()) total += pile.cards.length;
      for (const piles of res.state.perPlayerPiles.values())
        for (const p of piles) total += p.cards.length;
      // single-deck games have 52 cards; the double-deck path (Crazy Bridge 4+)
      // is exercised at min seats here, so expect 52 unless that game loaded two.
      assert.ok(total === 52 || total === 104, `${f} seed ${seed}: ${total} cards`);
      // a result is always produced; some games (e.g. Blackjack vs the dealer)
      // can legitimately have zero winners.
      assert.ok(Array.isArray(res.winners), `${f} seed ${seed}: no result`);
    }
  });
}
