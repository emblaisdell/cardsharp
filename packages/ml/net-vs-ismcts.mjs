// Can a non-tree-search learned policy hold its own against pure tree search?
// Pits a trained DMC/PPO net (one forward pass, no lookahead) against the fair
// Information-Set MCTS, on the authoritative Machine, seats rotated to cancel
// turn-order bias. The "vs random" column validates that the TS net port
// reproduces the Python eval win-rate.
//
//   node packages/ml/net-vs-ismcts.mjs [dmc|ppo]

import { compile, GameState, RNG, Machine } from "../core/src/index.ts";
import { NetPlayer } from "./src/netplay.ts";
import { ismctsAction } from "./src/ismcts.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const method = (process.argv[2] || "dmc").toLowerCase();

// game, seats (= training count), games-per-orientation, IS-MCTS iterations
const PLAN = [
  { file: "blackjack", seats: 2, games: 20, iters: 60 },
  { file: "thirtyone", seats: 2, games: 16, iters: 60 },
  { file: "thewall", seats: 2, games: 16, iters: 50 },
  { file: "gofish", seats: 2, games: 14, iters: 50 },
  { file: "tableless", seats: 2, games: 10, iters: 30 },
  { file: "oldmaid", seats: 3, games: 12, iters: 40 },
  { file: "crazybridge", seats: 3, games: 8, iters: 25 },
];

function playMatch(program, seats, seed, policies) {
  const m = new Machine(program, new GameState(seats, seed), () => { throw new Error("unused"); });
  m.state.onAnnounce = () => {};
  let r = m.start();
  let guard = 0;
  while (!r.done) {
    if (++guard > 300000) break;
    const req = r.request;
    const action = policies[req.player.id](m, req);
    m.supply(action);
    r = m.next();
  }
  return r.winners.map((p) => p.id);
}

// run `net` (one seat, rotated) vs an opponent factory; return net win-rate.
function netVsOpponent(program, seats, net, oppFactory, games, baseSeed) {
  let netWins = 0;
  let n = 0;
  for (let netSeat = 0; netSeat < seats; netSeat++) {
    for (let i = 0; i < games; i++) {
      const seed = baseSeed + i * 13 + netSeat * 7919;
      const rng = new RNG(seed ^ 0x55);
      const policies = [];
      for (let s = 0; s < seats; s++) {
        if (s === netSeat) policies.push((m, req) => net.choose(req, m.state.observe(req.player)));
        else policies.push(oppFactory(s, rng));
      }
      const w = playMatch(program, seats, seed, policies);
      if (w.includes(netSeat)) netWins++;
      n++;
    }
  }
  return netWins / Math.max(1, n);
}

console.log(`Non-tree-search RL (${method.toUpperCase()} net) vs pure tree search (fair IS-MCTS)`);
console.log("win-rate = the net's share (seats rotated). 'vs random' validates the TS port.\n");
console.log("game          net vs IS-MCTS   net vs random   IS-MCTS iters   wall");

for (const g of PLAN) {
  const program = compile(readFileSync(join(root, "games", `${g.file}.card`), "utf8"));
  let net;
  try {
    net = NetPlayer.fromJSON(JSON.parse(readFileSync(join(root, "models", "py", `${g.file}_${method}.netjson`), "utf8")));
  } catch {
    console.log(`${g.file.padEnd(13)} (no ${method} net)`);
    continue;
  }
  const t = Date.now();
  const vsRand = netVsOpponent(program, g.seats, net,
    (s, rng) => (m, req) => req.options[rng.int(req.options.length)], g.games, 5000);
  const vsMcts = netVsOpponent(program, g.seats, net,
    (s, rng) => (m) => ismctsAction(m, s, { iterations: g.iters, rolloutDepth: 20 }, rng), g.games, 2000);
  const pct = (x) => (100 * x).toFixed(0) + "%";
  console.log(
    `${g.file.padEnd(13)} ${pct(vsMcts).padStart(8)}${("(" + pct(1 - vsMcts) + ")").padStart(7)}` +
    `   ${pct(vsRand).padStart(8)}        ${String(g.iters).padStart(4)}        ${((Date.now() - t) / 1000).toFixed(0)}s`);
}
