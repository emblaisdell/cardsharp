import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile, runGame, GameState, RNG } from "../src/index.ts";
import type { ChoiceRequest, CSValue, Controller } from "../src/index.ts";
import { runToCompletion } from "../src/vm-sync.ts";
import { runMachine } from "../src/vm.ts";

// A SEEDED-random policy: it draws exactly once per decision from its own RNG.
// Given the same seed and the same decision sequence (same game, same game seed),
// the generator interpreter and the sync evaluator make identical choices, so
// they must reach the same winners — any divergence is a real VM bug. Randomness
// (vs. a fixed policy) breaks symmetric play that would otherwise loop forever in
// games like Thirty-One (perpetual ties → no elimination).
const POLICY_SEED = 777;
function makePolicy(): (req: ChoiceRequest) => CSValue {
  const rng = new RNG(POLICY_SEED);
  return (req: ChoiceRequest): CSValue =>
    req.options.length ? req.options[rng.int(req.options.length)] : null;
}

const gamesDir = fileURLToPath(new URL("../../../games/", import.meta.url));
const files = readdirSync(gamesDir).filter((f) => f.endsWith(".card"));

for (const f of files) {
  test(`${f}: synchronous evaluator matches the generator interpreter`, async () => {
    const program = compile(readFileSync(gamesDir + f, "utf8"));
    const range = (program.sections.find((s) => s.type === "PlayersDecl") as
      | { min: number; max: number }
      | undefined) ?? { min: 2, max: 2 };

    for (let seed = 0; seed < 5; seed++) {
      const seats = Math.min(range.max, range.min + (seed % 2));

      // generator interpreter: all seats share ONE counter so the sequence
      // matches the sync run's single counter
      const genPick = makePolicy();
      const controllers: Controller[] = Array.from({ length: seats }, () => ({
        choose: (req: ChoiceRequest) => genPick(req),
      }));
      const gen = await runGame(program, controllers, { players: seats, seed, quiet: true });
      const genWinners = gen.winners.map((p) => p.id).sort((a, b) => a - b);

      const syncWinners = runToCompletion(program, new GameState(seats, seed), makePolicy())
        .map((p) => p.id)
        .sort((a, b) => a - b);
      assert.deepEqual(syncWinners, genWinners, `${f} seed ${seed}: sync evaluator mismatch`);

      // the resumable stepper must also match (drives start/supply/next)
      const machineWinners = runMachine(program, new GameState(seats, seed), makePolicy())
        .map((p) => p.id)
        .sort((a, b) => a - b);
      assert.deepEqual(machineWinners, genWinners, `${f} seed ${seed}: stepper mismatch`);
    }
  });
}
