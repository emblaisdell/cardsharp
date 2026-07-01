import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile, GameState, RNG } from "../src/index.ts";
import type { ChoiceRequest, CSValue } from "../src/index.ts";
import { Machine } from "../src/vm.ts";

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../games/${name}`, import.meta.url)), "utf8");
}

// Cloning a machine at a decision yields an INDEPENDENT continuation: driven with
// the same answers, the clone reaches the same outcome as the original, and the
// two never share mutable state.
for (const [file, seats] of [["gofish.card", 3], ["thewall.card", 2], ["crazybridge.card", 4], ["thirtyone.card", 3]] as const) {
  test(`${file}: clone() is independent and consistent`, () => {
    const program = compile(read(file));
    const m = new Machine(program, new GameState(seats, 4), (req: ChoiceRequest) => req.options[0]);
    let r = m.start();
    // advance a couple of decisions, then clone mid-game
    let n = 0;
    while (!r.done && n < 3) {
      m.supply((r.request as ChoiceRequest).options[0]);
      r = m.next();
      n++;
    }
    if (r.done) return; // game ended before a clone point — nothing to check
    const m2 = m.clone();
    assert.notEqual(m.state, m2.state, "clone shares GameState");

    // drive both with identical seeded-random answers
    const drive = (mac: Machine, res: { done: boolean; request?: ChoiceRequest; winners?: unknown[] }): number[] => {
      const rng = new RNG(31);
      let g = 0;
      while (!res.done) {
        if (++g > 50000) break;
        const req = res.request as ChoiceRequest;
        const a: CSValue = req.options.length ? req.options[rng.int(req.options.length)] : null;
        mac.supply(a);
        res = mac.next();
      }
      return (res.winners as { id: number }[]).map((p) => p.id).sort((x, y) => x - y);
    };
    const wOrig = drive(m, r);
    const wClone = drive(m2, { done: false, request: m2.currentRequest as ChoiceRequest });
    assert.deepEqual(wClone, wOrig, `${file}: clone diverged from original`);
  });
}
