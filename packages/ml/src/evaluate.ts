// Evaluate a trained policy: how often does it win from a given seat against
// random opponents, versus a random player in that same seat (the baseline)?

import { runGame, compile, RandomController } from "../../core/src/index.ts";
import type { Controller } from "../../core/src/index.ts";
import { LinearPolicy } from "./policy.ts";
import { MLController } from "./controller.ts";

export interface EvalOptions {
  games?: number;
  players?: number;
  seat?: number;
  seed?: number;
}

export interface EvalResult {
  games: number;
  seat: number;
  mlWinRate: number;
  randomWinRate: number;
}

export async function evaluate(
  source: string,
  policy: LinearPolicy,
  opts: EvalOptions = {},
): Promise<EvalResult> {
  const program = compile(source);
  const games = opts.games ?? 1000;
  const seat = opts.seat ?? 0;
  const seed = opts.seed ?? 9999;
  const range = (program.sections.find((s) => s.type === "PlayersDecl") as
    | { min: number; max: number }
    | undefined) ?? { min: 2, max: 8 };
  const seats = opts.players ?? Math.max(2, range.min);

  let mlWins = 0;
  let randomWins = 0;

  for (let g = 0; g < games; g++) {
    // identical seed/opponents in both arms — only the test seat differs
    const mk = (testSeatIsML: boolean): Controller[] =>
      Array.from({ length: seats }, (_, s) =>
        s === seat && testSeatIsML
          ? new MLController(policy, { temperature: 0 })
          : new RandomController(seed + g * 131 + s * 7),
      );

    const ml = await runGame(program, mk(true), { players: seats, seed: seed + g, quiet: true });
    if (ml.winners.some((p) => p.id === seat)) mlWins++;

    const rnd = await runGame(program, mk(false), { players: seats, seed: seed + g, quiet: true });
    if (rnd.winners.some((p) => p.id === seat)) randomWins++;
  }

  return {
    games,
    seat,
    mlWinRate: mlWins / games,
    randomWinRate: randomWins / games,
  };
}
