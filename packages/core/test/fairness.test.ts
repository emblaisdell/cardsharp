import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runGame, FnController } from "../src/index.ts";
import type { ChoiceRequest, Observation, CSValue } from "../src/index.ts";

// The information boundary: a fair controller only ever receives (req, obs).
// This test asserts that the observation handed to the acting player NEVER
// contains a card the engine's visibility rules say they can't see — i.e. the
// inputs to Random/Linear bots leak no hidden information.

const gofish = readFileSync(
  fileURLToPath(new URL("../../../games/gofish.card", import.meta.url)),
  "utf8",
);

test("a player's observation hides every card it isn't allowed to see", async () => {
  let checks = 0;

  const auditing = (seat: number) =>
    new FnController((req: ChoiceRequest, obs: Observation): CSValue => {
      // the observer is always the acting player
      assert.equal(obs.viewer, seat);

      // private zones must be masked: opponents' hands (owner-visibility) and the
      // face-down stock (down). Public zones like `books` (up) are visible by
      // design and are not a leak.
      const hands = obs.zones.hand as { owner: number | null; cards: (CSValue | null)[] }[];
      hands.forEach((pile, owner) => {
        if (owner !== seat) {
          for (const c of pile.cards) {
            assert.equal(c, null, `opponent ${owner}'s hand leaked to ${seat}`);
          }
        }
      });
      const pond = obs.zones.pond as { cards: (CSValue | null)[] };
      for (const c of pond.cards) assert.equal(c, null, "face-down pond leaked");
      checks++;
      // make an arbitrary legal choice to keep the game moving
      return req.options.length ? req.options[0] : null;
    });

  await runGame(gofish, [0, 1, 2].map(auditing), { players: 3, seed: 7, quiet: true });
  assert.ok(checks > 0, "expected at least one audited decision");
});
