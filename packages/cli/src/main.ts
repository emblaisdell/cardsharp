#!/usr/bin/env node
// Card# command-line runner.
//
//   node packages/cli/src/main.ts run games/gofish.card --players 3 --seed 1
//   node packages/cli/src/main.ts run games/gofish.card --games 200 --quiet
//   node packages/cli/src/main.ts tokens games/gofish.card
//   node packages/cli/src/main.ts ast    games/gofish.card

import { readFileSync } from "node:fs";
import {
  runGame,
  compile,
  typecheck,
  winnerNames,
  lex,
  RandomController,
  FirstController,
  type Controller,
} from "../../core/src/index.ts";

interface Flags {
  players?: number;
  seed: number;
  games: number;
  quiet: boolean;
  controller: "random" | "first";
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { seed: 1, games: 1, quiet: false, controller: "random" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--players") f.players = Number(argv[++i]);
    else if (a === "--seed") f.seed = Number(argv[++i]);
    else if (a === "--games") f.games = Number(argv[++i]);
    else if (a === "--quiet") f.quiet = true;
    else if (a === "--controller") f.controller = argv[++i] as Flags["controller"];
    else throw new Error(`unknown flag: ${a}`);
  }
  return f;
}

function makeControllers(kind: string, seats: number, seed: number): Controller[] {
  const out: Controller[] = [];
  for (let i = 0; i < seats; i++) {
    out.push(kind === "first" ? new FirstController() : new RandomController(seed * 1000 + i));
  }
  return out;
}

async function cmdRun(file: string, flags: Flags): Promise<void> {
  const source = readFileSync(file, "utf8");
  const program = compile(source);
  const seats = flags.players ?? defaultSeats(program);

  if (flags.games === 1) {
    const controllers = makeControllers(flags.controller, seats, flags.seed);
    const result = await runGame(program, controllers, {
      players: seats,
      seed: flags.seed,
      quiet: flags.quiet,
    });
    console.log(`\n${program.name} — ${seats} players, seed ${flags.seed}`);
    console.log(`winner(s): ${winnerNames(result)}  (${result.steps} decisions)`);
    return;
  }

  // simulate many games and tally
  const wins = new Array(seats).fill(0);
  let draws = 0;
  for (let g = 0; g < flags.games; g++) {
    const controllers = makeControllers(flags.controller, seats, flags.seed + g);
    const result = await runGame(program, controllers, {
      players: seats,
      seed: flags.seed + g,
      quiet: true,
    });
    if (result.winners.length === 1) wins[result.winners[0].id]++;
    else draws++;
  }
  console.log(`\n${program.name} — ${flags.games} games, ${seats} players`);
  wins.forEach((w, i) => {
    const pct = ((100 * w) / flags.games).toFixed(1);
    console.log(`  P${i + 1}: ${w} wins (${pct}%)`);
  });
  if (draws) console.log(`  draws/ties: ${draws}`);
}

function defaultSeats(program: { sections: { type: string }[] }): number {
  const decl = program.sections.find((s) => s.type === "PlayersDecl") as
    | { min: number }
    | undefined;
  return decl?.min ?? 2;
}

function cmdTokens(file: string): void {
  const source = readFileSync(file, "utf8");
  for (const t of lex(source)) {
    if (t.type === "eof") break;
    console.log(`${String(t.line).padStart(4)}  ${t.type.padEnd(8)} ${t.value}`);
  }
}

function cmdAst(file: string): void {
  const source = readFileSync(file, "utf8");
  console.log(JSON.stringify(compile(source, { typecheck: false }), null, 2));
}

function cmdCheck(file: string): void {
  const source = readFileSync(file, "utf8");
  const diags = typecheck(source);
  if (diags.length === 0) {
    console.log(`✓ ${file} — no type errors`);
    return;
  }
  for (const d of diags) console.log(`${file}:${d.line}  ${d.message}`);
  console.log(`\n${diags.length} type error(s)`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`cardsharp — Card# runner

  run <file.card> [--players N] [--seed S] [--games G] [--quiet] [--controller random|first]
  check  <file.card>     type-check without running
  tokens <file.card>     show the token stream
  ast    <file.card>     show the parsed AST

Examples:
  cardsharp run games/gofish.card --players 3 --seed 7
  cardsharp run games/gofish.card --games 500 --quiet`);
    return;
  }
  if (!file) throw new Error(`command '${cmd}' needs a file argument`);

  if (cmd === "run") await cmdRun(file, parseFlags(rest));
  else if (cmd === "check") cmdCheck(file);
  else if (cmd === "tokens") cmdTokens(file);
  else if (cmd === "ast") cmdAst(file);
  else throw new Error(`unknown command: ${cmd}`);
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
