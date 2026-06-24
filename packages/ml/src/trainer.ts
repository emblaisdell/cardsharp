// Self-play REINFORCE trainer for the linear softmax policy.
//
// Every seat is played by the same (shared) policy in sampling mode; we record
// each seat's decisions, then after the game apply a policy-gradient update with
// the episode reward (+1 win / -1 loss) and a running-average baseline. This is
// classic linear policy-gradient RL — no neural nets, no dependencies.

import { runGame, compile } from "../../core/src/index.ts";
import type { RunResult } from "../../core/src/index.ts";
import { LinearPolicy } from "./policy.ts";
import { MLController, type Decision } from "./controller.ts";
import { DIM } from "./features.ts";

export interface TrainOptions {
  games?: number;
  players?: number;
  alpha?: number; // learning rate
  temperature?: number; // exploration temperature
  seed?: number;
  log?: (msg: string) => void;
}

export interface TrainResult {
  policy: LinearPolicy;
  games: number;
}

export async function train(source: string, opts: TrainOptions = {}): Promise<TrainResult> {
  const program = compile(source);
  const games = opts.games ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const temperature = opts.temperature ?? 1;
  const baseSeed = opts.seed ?? 1;
  const range = playersRange(program);
  const seats = opts.players ?? Math.max(2, range.min);

  const policy = new LinearPolicy();
  let baseline = 0;

  for (let g = 0; g < games; g++) {
    const trajectories: Decision[][] = Array.from({ length: seats }, () => []);
    const controllers = Array.from(
      { length: seats },
      (_, s) =>
        new MLController(policy, {
          temperature,
          seed: baseSeed * 100000 + g * 31 + s,
          record: (d) => trajectories[s].push(d),
        }),
    );

    const result = await runGame(program, controllers, {
      players: seats,
      seed: baseSeed + g,
      quiet: true,
    });

    const rewards = rewardsFor(result, seats);
    const meanReward = rewards.reduce((a, b) => a + b, 0) / seats;
    baseline = 0.99 * baseline + 0.01 * meanReward;

    for (let s = 0; s < seats; s++) {
      const advantage = rewards[s] - baseline;
      if (advantage === 0) continue;
      for (const d of trajectories[s]) reinforce(policy, d, advantage, alpha);
    }

    if (opts.log && (g + 1) % Math.max(1, Math.floor(games / 10)) === 0) {
      opts.log(`  game ${g + 1}/${games}  baseline=${baseline.toFixed(3)}`);
    }
  }

  return { policy, games };
}

// +1 for a winning seat, -1 otherwise (ties share the win equally as +1).
function rewardsFor(result: RunResult, seats: number): number[] {
  const winnerIds = new Set(result.winners.map((p) => p.id));
  const r: number[] = [];
  for (let s = 0; s < seats; s++) r.push(winnerIds.has(s) ? 1 : -1);
  return r;
}

// w += alpha * advantage * (φ_chosen - Σ_i p_i φ_i)
function reinforce(policy: LinearPolicy, d: Decision, advantage: number, alpha: number): void {
  if (d.rows.length <= 1) return; // no gradient when there's only one option
  const p = policy.probs(d.rows, 1);
  const chosen = d.rows[d.chosen];
  for (let k = 0; k < DIM; k++) {
    let expected = 0;
    for (let i = 0; i < d.rows.length; i++) expected += p[i] * d.rows[i][k];
    policy.weights[k] += alpha * advantage * (chosen[k] - expected);
  }
}

function playersRange(program: { sections: { type: string }[] }): { min: number; max: number } {
  const decl = program.sections.find((s) => s.type === "PlayersDecl") as
    | { min: number; max: number }
    | undefined;
  return decl ?? { min: 2, max: 8 };
}
