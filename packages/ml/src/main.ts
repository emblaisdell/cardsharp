#!/usr/bin/env node
// Card# ML trainer / evaluator.
//
//   node packages/ml/src/main.ts train games/blackjack.card --games 4000 --out models/blackjack.json
//   node packages/ml/src/main.ts eval  games/blackjack.card --model models/blackjack.json --games 2000

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { train } from "./trainer.ts";
import { evaluate } from "./evaluate.ts";
import { LinearPolicy, type ModelJSON } from "./policy.ts";

interface Flags {
  games?: number;
  players?: number;
  alpha: number;
  temp: number;
  seed: number;
  out?: string;
  model?: string;
  seat: number;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { alpha: 0.05, temp: 1, seed: 1, seat: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--games") f.games = Number(argv[++i]);
    else if (a === "--players") f.players = Number(argv[++i]);
    else if (a === "--alpha") f.alpha = Number(argv[++i]);
    else if (a === "--temp") f.temp = Number(argv[++i]);
    else if (a === "--seed") f.seed = Number(argv[++i]);
    else if (a === "--seat") f.seat = Number(argv[++i]);
    else if (a === "--out") f.out = argv[++i];
    else if (a === "--model") f.model = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  return f;
}

async function cmdTrain(file: string, f: Flags): Promise<void> {
  const source = readFileSync(file, "utf8");
  const games = f.games ?? 3000;
  console.log(`training on ${file} for ${games} self-play games…`);
  const { policy } = await train(source, {
    games,
    players: f.players,
    alpha: f.alpha,
    temperature: f.temp,
    seed: f.seed,
    log: (m) => console.log(m),
  });
  const model = policy.toJSON(file, games);
  if (f.out) {
    mkdirSync(dirname(f.out), { recursive: true });
    writeFileSync(f.out, JSON.stringify(model, null, 2));
    console.log(`saved model -> ${f.out}  (${model.weights.length} weights)`);
  }
  const res = await evaluate(source, policy, { games: 1000, players: f.players, seat: f.seat });
  report(res);
}

async function cmdEval(file: string, f: Flags): Promise<void> {
  const source = readFileSync(file, "utf8");
  if (!f.model) throw new Error("eval needs --model <model.json>");
  const model = JSON.parse(readFileSync(f.model, "utf8")) as ModelJSON;
  const policy = LinearPolicy.fromJSON(model);
  const res = await evaluate(source, policy, {
    games: f.games ?? 2000,
    players: f.players,
    seat: f.seat,
  });
  report(res);
}

function report(res: { games: number; seat: number; mlWinRate: number; randomWinRate: number }): void {
  const ml = (100 * res.mlWinRate).toFixed(1);
  const rnd = (100 * res.randomWinRate).toFixed(1);
  const lift = (100 * (res.mlWinRate - res.randomWinRate)).toFixed(1);
  console.log(`\nseat ${res.seat} over ${res.games} games vs random opponents:`);
  console.log(`  ML policy : ${ml}% win`);
  console.log(`  random    : ${rnd}% win   (baseline)`);
  console.log(`  lift      : ${lift} points`);
}

async function main(): Promise<void> {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help") {
    console.log(`cardsharp-ml — train/evaluate classical ML players

  train <game.card> [--games N] [--players P] [--alpha a] [--temp t] [--seed s] [--out model.json]
  eval  <game.card>  --model model.json [--games N] [--players P] [--seat i]`);
    return;
  }
  if (!file) throw new Error(`command '${cmd}' needs a game file`);
  if (cmd === "train") await cmdTrain(file, parseFlags(rest));
  else if (cmd === "eval") await cmdEval(file, parseFlags(rest));
  else throw new Error(`unknown command: ${cmd}`);
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
