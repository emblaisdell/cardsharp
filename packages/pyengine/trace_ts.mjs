// Emit a deterministic decision trace for a game using the TS engine, so the
// Python port can be diffed against it. Controller always picks options[0].
//
//   node trace_ts.mjs <game.card> <players> <seed>
import { runGame } from "../core/src/engine.ts";
import { display } from "../core/src/values.ts";
import { readFileSync } from "node:fs";

const [file, playersS, seedS] = process.argv.slice(2);
const src = readFileSync(file, "utf8");
const trace = [];
const controller = {
  async choose(req) {
    const ans = req.options[0];
    trace.push(`${req.player.id}:${display(ans)}`);
    return ans;
  },
};
const res = await runGame(src, () => controller, {
  players: Number(playersS),
  seed: Number(seedS),
  quiet: true,
});
console.log(JSON.stringify({
  trace,
  winners: res.winners.map((p) => p.id),
  steps: res.steps,
}));
