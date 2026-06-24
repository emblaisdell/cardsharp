import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { typecheck } from "../src/index.ts";

// wrap a flow body in a minimal game with a couple of zones
function game(body: string, extra = ""): string {
  return `game "T" {
    players 2;
    deck standard52;
    zone pond : pile;
    zone hand : pile per player;
    ${extra}
    flow { ${body} }
    winners => players;
  }`;
}

function errs(src: string): string[] {
  return typecheck(src).map((d) => d.message);
}

test("accepts well-typed programs (no diagnostics)", () => {
  assert.deepEqual(errs(game(`var n = size(pond) + 1; if (n > 0) { shuffle(pond); }`)), []);
});

test("rejects member access on the wrong type", () => {
  const e = errs(game(`var r = current.rank;`));
  assert.equal(e.length, 1);
  assert.match(e[0], /player has no property 'rank'/);
});

test("rejects wrong argument type to a builtin", () => {
  const e = errs(game(`var n = size(5);`));
  assert.match(e[0], /expected pile, got num/);
});

test("rejects calling a non-function", () => {
  const e = errs(game(`var x = 5; x(1);`));
  assert.match(e.join("\n"), /not callable/);
});

test("rejects arithmetic on a list", () => {
  const e = errs(game(`var z = [1, 2]; var y = z - 1;`));
  assert.match(e.join("\n"), /needs a number, got list<num>/);
});

test("rejects for-in over a non-list", () => {
  const e = errs(game(`for (x in 5) { log(x); }`));
  assert.match(e.join("\n"), /for-in expects a list/);
});

test("rejects undefined names", () => {
  const e = errs(game(`var x = totallyUndefined;`));
  assert.match(e.join("\n"), /undefined name 'totallyUndefined'/);
});

test("flows card element types into lambdas", () => {
  // c is inferred as a card from cards(pond); .nonsense must be rejected
  const e = errs(game(`var bad = filter(cards(pond), c => c.nonsense == 1);`));
  assert.match(e.join("\n"), /card has no property 'nonsense'/);
});

test("the real Go Fish game type-checks clean", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../../games/gofish.card", import.meta.url)),
    "utf8",
  );
  assert.deepEqual(typecheck(src), []);
});
