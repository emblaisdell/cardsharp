// The hybrid vs its two parents. For each game (at its training player count),
// reports win-rate of: bare net vs IS-MCTS, the Neural-IS-MCTS hybrid vs IS-MCTS,
// and the hybrid vs the bare net. Seats rotated to cancel turn-order bias.
//
//   node packages/ml/hybrid-arena.mjs [dmc|ppo]

import { compile, GameState, RNG, Machine } from "../core/src/index.ts";
import { NetPlayer } from "./src/netplay.ts";
import { ismctsAction } from "./src/ismcts.ts";
import { neuralIsmctsAction } from "./src/neural-ismcts.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const method = (process.argv[2] || "dmc").toLowerCase();
const ITERS = 80;

// 2p games (clean head-to-head); seats rotated. games = per orientation.
const PLAN = [
  { file: "thirtyone", games: 24 },
  { file: "thewall", games: 20 },
  { file: "blackjack", games: 30 },
  { file: "gofish", games: 16 },
];

function makeMachine(program, seats, seed) {
  const m = new Machine(program, new GameState(seats, seed), () => { throw new Error("unused"); });
  m.state.onAnnounce = () => {};
  return m;
}

// A and B are (machine, req, rng) -> option. Returns A's win share over rotated seats.
function duel(program, A, B, games, baseSeed) {
  let aWins = 0; let n = 0;
  for (let aSeat = 0; aSeat < 2; aSeat++) {
    for (let i = 0; i < games; i++) {
      const seed = baseSeed + i * 13 + aSeat * 7919;
      const rng = new RNG(seed ^ 0x55);
      const m = makeMachine(program, 2, seed);
      let r = m.start(); let g = 0;
      while (!r.done) {
        if (++g > 300000) break;
        const seat = r.request.player.id;
        const action = (seat === aSeat ? A : B)(m, r.request, rng);
        m.supply(action); r = m.next();
      }
      if (r.winners.map((p) => p.id).includes(aSeat)) aWins++;
      n++;
    }
  }
  return aWins / Math.max(1, n);
}

console.log(`Hybrid (Neural-IS-MCTS, ${method.toUpperCase()} prior, leaf=rollout) vs its parents`);
console.log(`win-rate = first agent's share, seats rotated, ${ITERS} iters.\n`);
console.log("game         bareNet/ISMCTS   HYBRID/ISMCTS   HYBRID/bareNet   wall");

const pct = (x) => (100 * x).toFixed(0) + "%";
for (const g of PLAN) {
  const program = compile(readFileSync(join(root, "games", `${g.file}.card`), "utf8"));
  const net = NetPlayer.fromJSON(JSON.parse(readFileSync(join(root, "models", "py", `${g.file}_${method}.netjson`), "utf8")));
  const bareNet = (m, req) => net.choose(req, m.state.observe(req.player));
  const mcts = (m, req, rng) => ismctsAction(m, req.player.id, { iterations: ITERS, rolloutDepth: 20 }, rng);
  const hybrid = (m, req, rng) => neuralIsmctsAction(m, req.player.id, net, { iterations: ITERS, leaf: "rollout", rolloutDepth: 20 }, rng);

  const t = Date.now();
  const a = duel(program, bareNet, mcts, g.games, 1000);
  const b = duel(program, hybrid, mcts, g.games, 2000);
  const c = duel(program, hybrid, bareNet, g.games, 3000);
  console.log(
    `${g.file.padEnd(12)} ${pct(a).padStart(8)}        ${pct(b).padStart(8)}        ${pct(c).padStart(8)}` +
    `        ${((Date.now() - t) / 1000).toFixed(0)}s`);
}
