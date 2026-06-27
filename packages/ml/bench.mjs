// Train (longer) + benchmark every game, recording exact compute, and write
// docs/ml-benchmarks.md + models/benchmarks.json. Results are written after each
// game so partial runs still produce a usable report.
//
//   node packages/ml/bench.mjs            # full run
//   node packages/ml/bench.mjs quick      # smaller counts for a fast smoke

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../core/src/index.ts";
import { train, winRate, randomFactory, linearFactory, mctsFactory } from "./src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const quick = process.argv[2] === "quick";

// per-game plan. MCTS re-simulates a full game per playout, so its cost scales
// with game length; we only run it where a game is short enough to be practical.
// Counts are time-budgeted: short games train more (they're cheap); long
// multi-round games train fewer and skip MCTS (a single MCTS move re-simulates a
// whole game, so it's impractical once games are hundreds-to-thousands of
// decisions long).
const PLAN = [
  { file: "blackjack", seats: 2, train: 8000, evalN: 1500, mcts: { sims: 60, games: 30 } },
  { file: "thirtyone", seats: 3, train: 2500, evalN: 1000, mcts: { sims: 30, games: 12 } },
  { file: "gofish", seats: 3, train: 3000, evalN: 800, mcts: { sims: 30, games: 12 } },
  { file: "thewall", seats: 2, train: 3000, evalN: 800, mcts: { sims: 30, games: 12 } },
  { file: "oldmaid", seats: 4, train: 1000, evalN: 800, mcts: null, note: "no player decisions — all methods equal chance" },
  { file: "tableless", seats: 4, train: 1500, evalN: 250, mcts: null, note: "MCTS engine-bound (~250 decisions/game; re-simulation cost)" },
  { file: "crazybridge", seats: 4, train: 400, evalN: 120, mcts: null, note: "MCTS engine-bound (~1200 decisions/game)" },
  { file: "moneymoneymoney", seats: 4, train: 200, evalN: 100, mcts: null, note: "MCTS engine-bound (~3800 decisions/game)" },
];

const scale = quick ? 0.02 : 1;
const rows = [];

for (const g of PLAN) {
  const src = readFileSync(join(root, "games", `${g.file}.card`), "utf8");
  const program = compile(src);
  const seats = g.seats;
  const evalN = Math.max(50, Math.round(g.evalN * scale));
  const trainMs = quick ? 2000 : 25000; // fixed wall-time budget per model

  process.stdout.write(`\n[${g.file}] training linear for ~${(trainMs / 1000) | 0}s (${seats}p)…\n`);
  const tr = await train(src, {
    games: 1_000_000, players: seats, maxMs: trainMs, alpha: 0.05, temperature: 1, seed: 1,
  });
  mkdirSync(join(root, "models"), { recursive: true });
  writeFileSync(join(root, "models", `${g.file}.json`), JSON.stringify(tr.policy.toJSON(g.file, tr.games), null, 2));

  process.stdout.write(`  trained in ${(tr.ms / 1000).toFixed(1)}s over ${tr.decisions.toLocaleString()} decisions ` +
    `(${Math.round(tr.decisions / (tr.ms / 1000)).toLocaleString()} dec/s). evaluating…\n`);

  const rnd = await winRate(program, randomFactory(), { games: evalN, seats, seed: 9000, maxMs: 25000 });
  const lin = await winRate(program, linearFactory(tr.policy), { games: evalN, seats, seed: 9000, maxMs: 25000 });

  let mc = null;
  if (g.mcts && !quick) {
    const sims = g.mcts.sims;
    process.stdout.write(`  MCTS-${sims} (perfect-info baseline, ~35s budget)…\n`);
    const r = await winRate(program, mctsFactory(sims), { games: 100000, seats, seed: 9000, maxMs: 35000 });
    mc = { sims, ...r };
  }

  rows.push({
    game: g.file, seats, note: g.note ?? "",
    train: { games: tr.games, decisions: tr.decisions, ms: tr.ms },
    random: rnd.winRate, linear: lin.winRate, mcts: mc,
  });
  writeReport(rows);
  process.stdout.write(`  random ${(100 * rnd.winRate).toFixed(1)}%  |  linear ${(100 * lin.winRate).toFixed(1)}%` +
    (mc ? `  |  MCTS-${mc.sims} ${(100 * mc.winRate).toFixed(1)}% (${mc.msPerMove.toFixed(0)}ms/move)` : "") + "\n");
}

process.stdout.write(`\nDone. Wrote docs/ml-benchmarks.md and models/benchmarks.json\n`);

function pct(x) {
  return (100 * x).toFixed(1) + "%";
}

function writeReport(rows) {
  writeFileSync(join(root, "models", "benchmarks.json"), JSON.stringify(rows, null, 2));

  const trainTable = [
    "| Game | Seats | Train games | Train decisions | Wall-time | Throughput |",
    "|------|------:|------------:|----------------:|----------:|-----------:|",
    ...rows.map((r) =>
      `| ${r.game} | ${r.seats} | ${r.train.games.toLocaleString()} | ${r.train.decisions.toLocaleString()} | ` +
      `${(r.train.ms / 1000).toFixed(1)}s | ${Math.round(r.train.decisions / (r.train.ms / 1000)).toLocaleString()} dec/s |`),
  ].join("\n");

  const capTable = [
    "| Game | Random (seat 0) | Linear PG | Linear lift | MCTS | MCTS cost | MCTS sims |",
    "|------|---------------:|----------:|-----------:|-----:|----------:|----------:|",
    ...rows.map((r) => {
      const lift = `${((r.linear - r.random) * 100 >= 0 ? "+" : "")}${((r.linear - r.random) * 100).toFixed(1)}`;
      const mc = r.mcts ? pct(r.mcts.winRate) : "—";
      const cost = r.mcts ? `${r.mcts.msPerMove.toFixed(0)} ms/move` : "—";
      const sims = r.mcts ? String(r.mcts.sims) : "—";
      return `| ${r.game} | ${pct(r.random)} | ${pct(r.linear)} | ${lift} pt | ${mc} | ${cost} | ${sims} |`;
    }),
  ].join("\n");

  const totalTrainMs = rows.reduce((a, r) => a + r.train.ms, 0);
  const totalTrainDec = rows.reduce((a, r) => a + r.train.decisions, 0);

  const md = `# ♠# ML benchmarks

*Auto-generated by \`packages/ml/bench.mjs\`. Each method plays **seat 0** against
**random** opponents; win-rates are over independent games with shared seeds, so
rows are directly comparable. "Random (seat 0)" is the baseline — note it isn't
\`1/seats\` because seating/turn order carries an edge in several games.*

## Methods compared

- **Random** — uniform legal move. No training.
- **Linear PG** — linear softmax policy over hand-crafted features, trained by
  self-play REINFORCE (\`packages/ml\`). The trained artifact is a ~1 KB JSON.
- **MCTS** — general UCT search that re-simulates the game to evaluate moves
  (\`packages/ml/src/mcts.ts\`). **Perfect-information / "cheating" baseline:** each
  playout uses the real game seed, so it sees the true shuffle and opponents'
  hidden cards. It's a strong *upper bound*, not a fair hidden-info player, and it
  does **no training** — it spends compute *per move* instead.

## Training compute (Linear PG)

${trainTable}

Totals: **${totalTrainDec.toLocaleString()}** training decisions in
**${(totalTrainMs / 1000).toFixed(1)}s** of wall-clock across all models.
Each model is a ${"`"}LinearPolicy${"`"} weight vector (~26 floats). Hardware: whatever ran
the script (single-threaded Node).

## Capability (win-rate vs random opponents)

${capTable}

\`Linear lift\` = Linear − Random (percentage points). MCTS \`ms/move\` is the
average wall-time the search spent per decision at the listed simulation count;
multiply by decisions-per-game to get its cost for a full game (this is why it's
omitted for the long games).

## How to reproduce

\`\`\`bash
node packages/ml/bench.mjs          # full run (writes this file + models/)
node packages/ml/bench.mjs quick    # 2% counts, linear only — fast smoke
\`\`\`

## Reading the comparison

- **Linear PG vs Random** isolates what a cheap, classical learner extracts from
  generic features — a few points in low-signal games, tens of points where the
  features capture the key decision (e.g. Thirty-One).
- **MCTS vs Linear** is the headroom: a search that actually looks ahead (here
  with perfect information) shows how much skill the game rewards beyond the
  linear model. The gap is the case for better learners (game-specific features,
  value functions, or fair information-set MCTS).
- **Compute**: Linear PG pays once at training time (the table above) then plays
  for free (one dot product/move). MCTS pays *nothing* up front but a large,
  tunable cost every move. That trade-off is the main axis for comparing methods.
- **Negative lift is real and informative.** In some games the linear policy does
  *worse* than random — for two reasons: (a) the **generic features mislead** (the
  decisive signal, e.g. which rank to ask for in Go Fish or which meld to bank in
  Money³, isn't in the feature set, so the learner confidently optimizes the wrong
  thing); and (b) **too little training** (the long multi-round games fit only
  dozens-to-hundreds of self-play games into the 25s budget — see Train games —
  far too few to converge). Both point to the same fixes: game-specific features
  and/or far more training. The perfect-information MCTS column shows the skill
  ceiling those games actually reward.
`;
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "ml-benchmarks.md"), md);
}
