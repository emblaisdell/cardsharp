// Install the Card# VSCode extension by symlinking this folder into the user's
// VSCode extensions directory. Re-runnable (idempotent).

import { existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  join(homedir(), ".vscode", "extensions"),
  join(homedir(), ".vscode-server", "extensions"),
  join(homedir(), ".vscode-oss", "extensions"),
  join(homedir(), ".cursor", "extensions"),
];

const extDir = candidates.find((d) => existsSync(d)) ?? candidates[0];
mkdirSync(extDir, { recursive: true });

const target = join(extDir, "cardsharp.cardsharp-0.1.0");

if (existsSync(target) || isSymlink(target)) rmSync(target, { recursive: true, force: true });
symlinkSync(here, target, "dir");

console.log(`Installed Card# extension:`);
console.log(`  ${target}  ->  ${here}`);
console.log(`\nReload VSCode (Command Palette: "Developer: Reload Window") and open a .card file.`);

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
