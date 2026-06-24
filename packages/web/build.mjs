// Build the static browser bundle with zero dependencies.
//
// The core and ml packages are written in plain (erasable) TypeScript, so we
// strip the types with Node's built-in `stripTypeScriptTypes` and rewrite the
// `.ts` import specifiers to `.js`. The result is native ES modules a browser
// loads directly — no esbuild, no webpack, no npm install.

import { stripTypeScriptTypes } from "node:module";
import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const pub = join(here, "public");
const outLib = join(pub, "lib");

rmSync(outLib, { recursive: true, force: true });
mkdirSync(join(outLib, "core"), { recursive: true });
mkdirSync(join(outLib, "ml"), { recursive: true });

function transpileDir(srcDir, outDir, rewrites) {
  let n = 0;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".ts") || f.endsWith("main.ts")) continue;
    let js = stripTypeScriptTypes(readFileSync(join(srcDir, f), "utf8"), { mode: "strip" });
    for (const [from, to] of rewrites) js = js.split(from).join(to);
    js = js.replace(/\.ts(['"])/g, ".js$1"); // rewrite import specifiers
    writeFileSync(join(outDir, f.replace(/\.ts$/, ".js")), js);
    n++;
  }
  return n;
}

const nCore = transpileDir(join(root, "packages/core/src"), join(outLib, "core"), []);
const nMl = transpileDir(join(root, "packages/ml/src"), join(outLib, "ml"), [
  ["../../core/src/", "../core/"],
]);

// copy game sources and any trained models so the static app can fetch them
const pubGames = join(pub, "games");
mkdirSync(pubGames, { recursive: true });
const cards = readdirSync(join(root, "games")).filter((f) => f.endsWith(".card"));
for (const f of cards) cpSync(join(root, "games", f), join(pubGames, f));
writeFileSync(join(pubGames, "index.json"), JSON.stringify(cards, null, 2));

if (existsSync(join(root, "models"))) {
  const pm = join(pub, "models");
  mkdirSync(pm, { recursive: true });
  for (const f of readdirSync(join(root, "models"))) {
    if (f.endsWith(".json")) cpSync(join(root, "models", f), join(pm, f));
  }
}

console.log(`built: ${nCore} core modules, ${nMl} ml modules, ${cards.length} games -> ${pub}`);
