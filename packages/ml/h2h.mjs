// Head-to-head: fair IS-MCTS vs the trained linear model, across games.
// Both play on the authoritative Machine; we swap their seats each batch to
// cancel turn-order bias. Extra seats (3p+ games) are random.
//
//   node packages/ml/h2h.mjs

import { compile, GameState, RNG, Machine } from "../core/src/index.ts";
import { LinearPolicy, MLController } from "./src/index.ts";
import { ismctsAction } from "./src/ismcts.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

// game, seats, games-per-orientation, IS-MCTS iterations
const PLAN = [
  { file: "blackjack", seats: 2, games: 20, iters: 60 },
  { file: "thewall", seats: 2, games: 16, iters: 50 },
  { file: "gofish", seats: 3, games: 14, iters: 40 },
  { file: "thirtyone", seats: 3, games: 14, iters: 40 },
  { file: "tableless", seats: 4, games: 8, iters: 25 },
];

function playMatch(program, seats, seed, policies) {
  const m = new Machine(program, new GameState(seats, seed), () => { throw new Error("unused"); });
  m.state.onAnnounce = () => {}; // suppress narration during the benchmark
  let r = m.start();
  let guard = 0;
  while (!r.done) {
    if (++guard > 200000) break;
    const req = r.request;
    const action = policies[req.player.id](m, req);
    m.supply(action);
    r = m.next();
  }
  return r.winners.map((p) => p.id);
}

console.log("IS-MCTS vs trained linear model (win-rate per side; seats swapped to cancel bias)\n");
console.log("game          IS-MCTS   linear   (other seats: random)   wall-time");

for (const g of PLAN) {
  const program = compile(readFileSync(join(root, "games", `${g.file}.card`), "utf8"));
  const model = JSON.parse(readFileSync(join(root, "models", `${g.file}.json`), "utf8"));
  const policy = LinearPolicy.fromJSON(model);

  let isWins = 0, mlWins = 0, n = 0;
  const t = Date.now();

  for (let orient = 0; orient < 2; orient++) {
    const isSeat = orient === 0 ? 0 : 1;
    const mlSeat = orient === 0 ? 1 : 0;
    for (let i = 0; i < g.games; i++) {
      const seed = 1000 + i * 13 + orient * 7919;
      const rng = new RNG(seed ^ 0x55);
      const ml = new MLController(policy, { temperature: 0 });
      const policies = [];
      for (let s = 0; s < g.seats; s++) {
        if (s === isSeat) policies.push((m) => ismctsAction(m, isSeat, { iterations: g.iters, rolloutDepth: 20 }, rng));
        else if (s === mlSeat) policies.push((m, req) => ml.choose(req, m.state.observe(req.player)));
        else policies.push((m, req) => req.options[rng.int(req.options.length)]);
      }
      const w = playMatch(program, g.seats, seed, policies);
      if (w.includes(isSeat)) isWins++;
      if (w.includes(mlSeat)) mlWins++;
      n++;
    }
  }
  const pct = (x) => ((100 * x) / n).toFixed(0) + "%";
  console.log(`${g.file.padEnd(13)} ${pct(isWins).padStart(6)}  ${pct(mlWins).padStart(7)}   ${String(n).padStart(3)} games${" ".repeat(13)}${((Date.now() - t) / 1000).toFixed(0)}s`);
}
