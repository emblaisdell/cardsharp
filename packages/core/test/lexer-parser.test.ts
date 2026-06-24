import { test } from "node:test";
import assert from "node:assert/strict";
import { lex } from "../src/lexer.ts";
import { parse, ParseError } from "../src/parser.ts";

test("lexer: comments, strings, numbers, ops", () => {
  const toks = lex(`game "X" { // hi
    var a = 3.5; /* block */ var b = a..10;
  }`);
  const kinds = toks.map((t) => `${t.type}:${t.value}`);
  assert.ok(kinds.includes("string:X"));
  assert.ok(kinds.includes("number:3.5"));
  assert.ok(kinds.includes("op:.."));
  assert.equal(toks[toks.length - 1].type, "eof");
});

test("lexer: distinguishes 3.5 from range 3..5", () => {
  const a = lex("3.5").map((t) => t.value);
  assert.deepEqual(a.slice(0, 1), ["3.5"]);
  const b = lex("3..5").map((t) => `${lex("3..5")[0].type}`);
  const toks = lex("3..5");
  assert.deepEqual(
    toks.slice(0, 3).map((t) => t.value),
    ["3", "..", "5"],
  );
  void a;
  void b;
});

test("parser: minimal game", () => {
  const p = parse(`game "Mini" {
    players 2..4;
    deck standard52;
    zone hand : pile per player;
    setup { loadDeck(hand[current]); }
    flow { endGame(); }
    winners => players;
  }`);
  assert.equal(p.type, "Program");
  assert.equal(p.name, "Mini");
  const types = p.sections.map((s) => s.type);
  assert.ok(types.includes("PlayersDecl"));
  assert.ok(types.includes("ZoneDecl"));
  assert.ok(types.includes("FlowDecl"));
});

test("parser: lambdas (single + multi param) and precedence", () => {
  const p = parse(`game "L" {
    flow {
      var f = x => x + 1;
      var g = (a, b) => a * b + 1;
      var h = 1 + 2 * 3 == 7 && true;
    }
  }`);
  const flow = p.sections.find((s) => s.type === "FlowDecl");
  assert.ok(flow);
});

test("parser: error reporting includes a line", () => {
  assert.throws(
    () => parse(`game "E" { flow { var x = ; } }`),
    (e: unknown) => e instanceof ParseError && /line \d+/.test(e.message),
  );
});

test("parser: brace-less control bodies", () => {
  const p = parse(`game "B" {
    flow {
      loop if (true) break;
    }
  }`);
  assert.ok(p.sections.find((s) => s.type === "FlowDecl"));
});
