// Pit controllers against each other and measure both win-rate and compute.
//
// A "test" seat plays one method; the other seats play random. We feed the
// per-game answer history into a shared array via onChoice, which is exactly
// what the MctsController needs to re-simulate. Every matchup reuses the same
// seeds, so comparisons are apples-to-apples.

import { runGame, RandomController } from "../../core/src/index.ts";
import type { Controller, CSValue } from "../../core/src/index.ts";
import type * as A from "../../core/src/ast.ts";
import { LinearPolicy } from "./policy.ts";
import { MLController } from "./controller.ts";
import { MctsController } from "./mcts.ts";

export interface FactoryCtx {
  program: A.Program;
  seed: number;
  players: number;
  history: CSValue[];
}
export type Factory = (seat: number, ctx: FactoryCtx) => Controller;

export interface MatchResult {
  winRate: number;
  games: number;
  decisions: number; // total decision points across all games
  ms: number; // wall-clock
  msPerMove: number;
}

export async function winRate(
  program: A.Program,
  factory: Factory,
  opts: { games: number; seats: number; seed?: number; testSeat?: number; maxMs?: number },
): Promise<MatchResult> {
  const seed = opts.seed ?? 1;
  const testSeat = opts.testSeat ?? 0;
  let wins = 0;
  let decisions = 0;
  let testMoves = 0;
  const t0 = Date.now();

  let played = 0;
  for (let g = 0; g < opts.games; g++) {
    if (opts.maxMs && Date.now() - t0 > opts.maxMs) break;
    played = g + 1;
    const gseed = seed + g;
    const history: CSValue[] = [];
    const controllers: Controller[] = [];
    for (let s = 0; s < opts.seats; s++) {
      controllers.push(factory(s, { program, seed: gseed, players: opts.seats, history }));
    }
    const res = await runGame(program, controllers, {
      players: opts.seats,
      seed: gseed,
      quiet: true,
      onChoice: (req, _obs, ans) => {
        history.push(ans);
        decisions++;
        if (req.player.id === testSeat) testMoves++;
      },
    });
    if (res.winners.some((p) => p.id === testSeat)) wins++;
  }

  const ms = Date.now() - t0;
  return {
    winRate: played ? wins / played : 0,
    games: played,
    decisions,
    ms,
    msPerMove: testMoves ? ms / testMoves : 0,
  };
}

// ---- ready-made factories (test method in `testSeat`, random elsewhere) ----
export function randomFactory(): Factory {
  return (seat, ctx) => new RandomController(ctx.seed * 100 + seat * 7);
}

export function linearFactory(policy: LinearPolicy, testSeat = 0): Factory {
  return (seat, ctx) =>
    seat === testSeat
      ? new MLController(policy, { temperature: 0 })
      : new RandomController(ctx.seed * 100 + seat * 7);
}

export function mctsFactory(
  simulations: number,
  testSeat = 0,
  extra: { heuristic?: boolean; rolloutDepth?: number; c?: number } = {},
): Factory {
  return (seat, ctx) =>
    seat === testSeat
      ? new MctsController({
          program: ctx.program,
          seed: ctx.seed,
          players: ctx.players,
          history: ctx.history,
          simulations,
          perfectInfo: true, // labeled perfect-information benchmark baseline
          ...extra,
        })
      : new RandomController(ctx.seed * 100 + seat * 7);
}
