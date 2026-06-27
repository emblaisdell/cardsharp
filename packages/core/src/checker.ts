// Static type checker for ♠#. Produces diagnostics (with line numbers) that
// the compiler reports before a game ever runs.

import type * as A from "./ast.ts";
import type { Type } from "./types.ts";
import { T, assignable, show } from "./types.ts";

export interface Diagnostic {
  line: number;
  message: string;
}

export class TypeCheckError extends Error {
  diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(
      "Type error(s):\n" +
        diagnostics.map((d) => `  line ${d.line}: ${d.message}`).join("\n"),
    );
    this.diagnostics = diagnostics;
  }
}

class Scope {
  vars = new Map<string, Type>();
  parent: Scope | null;
  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }
  define(n: string, t: Type): void {
    this.vars.set(n, t);
  }
  lookup(n: string): Type | null {
    let s: Scope | null = this;
    while (s) {
      const t = s.vars.get(n);
      if (t) return t;
      s = s.parent;
    }
    return null;
  }
}

// A builtin signature is either a fixed function type or a custom checker that
// inspects the call (needed for the polymorphic collection builtins).
type Sig =
  | { fixed: Type } // a {k:"fun"} Type
  | { custom: (c: Checker, call: A.Call) => Type };

export function check(program: A.Program): Diagnostic[] {
  return new Checker(program).run();
}

class Checker {
  private program: A.Program;
  private diags: Diagnostic[] = [];
  private global = new Scope();
  private fnReturns: Type[] = []; // collects return types of the current fn

  constructor(program: A.Program) {
    this.program = program;
  }

  run(): Diagnostic[] {
    this.installGlobals();
    for (const s of this.program.sections) this.checkSection(s);
    return this.diags;
  }

  private err(line: number, message: string): void {
    this.diags.push({ line, message });
  }

  // ---- global environment ----
  private installGlobals(): void {
    const g = this.global;
    g.define("current", T.player);
    g.define("players", T.list(T.player));
    g.define("activePlayers", T.list(T.player));
    for (const n of ["Ace", "Jack", "Queen", "King", "Clubs", "Diamonds", "Hearts", "Spades", "♣", "♦", "♥", "♠"]) {
      g.define(n, T.num);
    }
    g.define("ranks", T.list(T.num));
    g.define("suits", T.list(T.num));

    // zones
    for (const s of this.program.sections) {
      if (s.type === "ZoneDecl") g.define(s.name, s.perPlayer ? T.family : T.pile);
    }
    // user functions (pre-declared so calls type-check before bodies are read)
    for (const s of this.program.sections) {
      if (s.type === "FunctionDecl") {
        g.define(s.name, T.fun(s.params.map(() => T.any), T.any));
      } else if (s.type === "ScoreDecl") {
        g.define("score", T.fun([T.any], T.num));
      }
    }
  }

  // ---- sections ----
  private checkSection(s: A.Section): void {
    switch (s.type) {
      case "VarDecl":
        this.global.define(s.name, this.infer(s.init, this.global));
        return;
      case "SetupDecl":
      case "FlowDecl":
        this.checkBlock(s.body, new Scope(this.global));
        return;
      case "FunctionDecl": {
        const scope = new Scope(this.global);
        for (const p of s.params) scope.define(p, T.any);
        const saved = this.fnReturns;
        this.fnReturns = [];
        this.checkBlock(s.body, scope);
        this.fnReturns = saved;
        return;
      }
      case "ScoreDecl": {
        const scope = new Scope(this.global);
        scope.define(s.param, T.player);
        const t = this.infer(s.expr, scope);
        if (!assignable(t, T.num)) this.err(s.line, `score must be a number, got ${show(t)}`);
        return;
      }
      case "WinnersDecl": {
        const t = this.infer(s.expr, this.global);
        if (!assignable(t, T.player) && !assignable(t, T.list(T.player))) {
          this.err(s.line, `winners must be a player or list of players, got ${show(t)}`);
        }
        return;
      }
      default:
        return; // PlayersDecl, DeckDecl, ZoneDecl: nothing to check
    }
  }

  // ---- statements ----
  private checkBlock(block: A.Block, parent: Scope): void {
    const scope = new Scope(parent);
    for (const st of block.stmts) this.checkStmt(st, scope);
  }

  private checkStmt(st: A.Stmt, scope: Scope): void {
    switch (st.type) {
      case "Block":
        this.checkBlock(st, scope);
        return;
      case "VarStmt":
        scope.define(st.name, this.infer(st.init, scope));
        return;
      case "AssignStmt": {
        const vt = this.infer(st.value, scope);
        const t = st.target;
        if (t.type === "Identifier") {
          const existing = scope.lookup(t.name);
          if (!existing) this.err(st.line, `assignment to undeclared variable '${t.name}'`);
          else if (!assignable(vt, existing)) {
            this.err(st.line, `cannot assign ${show(vt)} to '${t.name}' of type ${show(existing)}`);
          }
        } else if (t.type === "Member") {
          const ot = this.infer(t.obj, scope);
          if (ot.k === "card" && t.prop === "value") {
            if (!assignable(vt, T.num)) this.err(st.line, `card.value must be a number`);
          } else if (ot.k === "player" && t.prop === "name") {
            if (!assignable(vt, T.str)) this.err(st.line, `player.name must be a string`);
          } else if (ot.k !== "any") {
            this.err(st.line, `cannot assign to ${show(ot)}.${t.prop}`);
          }
        } else {
          this.infer(t, scope); // index assignment; just validate the target
        }
        return;
      }
      case "ExprStmt":
        this.infer(st.expr, scope);
        return;
      case "IfStmt":
        this.infer(st.cond, scope);
        this.checkBlock(st.then, scope);
        if (st.otherwise) {
          if (st.otherwise.type === "IfStmt") this.checkStmt(st.otherwise, scope);
          else this.checkBlock(st.otherwise, scope);
        }
        return;
      case "WhileStmt":
        this.infer(st.cond, scope);
        this.checkBlock(st.body, scope);
        return;
      case "LoopStmt":
        this.checkBlock(st.body, scope);
        return;
      case "RepeatStmt": {
        const ct = this.infer(st.count, scope);
        if (!assignable(ct, T.num)) this.err(st.line, `repeat count must be a number, got ${show(ct)}`);
        this.checkBlock(st.body, scope);
        return;
      }
      case "ForStmt": {
        const it = this.infer(st.iter, scope);
        const el = it.k === "list" ? it.el : it.k === "any" ? T.any : null;
        if (el === null) this.err(st.line, `for-in expects a list, got ${show(it)}`);
        const body = new Scope(scope);
        body.define(st.name, el ?? T.any);
        for (const s of st.body.stmts) this.checkStmt(s, body);
        return;
      }
      case "ReturnStmt":
        this.fnReturns.push(st.expr ? this.infer(st.expr, scope) : T.void);
        return;
      case "BreakStmt":
      case "ContinueStmt":
        return;
    }
  }

  // ---- expressions ----
  // `expected` enables bidirectional checking of lambda parameter types.
  infer(e: A.Expr, scope: Scope, expected?: Type): Type {
    switch (e.type) {
      case "NumberLit":
        return T.num;
      case "StringLit":
        return T.str;
      case "BoolLit":
        return T.bool;
      case "NullLit":
        return T.null;
      case "ListLit": {
        if (e.elements.length === 0) return T.list(T.any);
        const elTypes = e.elements.map((x) => this.infer(x, scope));
        const first = elTypes[0];
        const homogeneous = elTypes.every((t) => assignable(t, first) || assignable(first, t));
        return T.list(homogeneous ? first : T.any);
      }
      case "RecordLit":
        for (const ent of e.entries) this.infer(ent.value, scope);
        return T.record;
      case "Identifier": {
        const t = scope.lookup(e.name);
        if (t) return t;
        if (BUILTINS.has(e.name)) return builtinFnType(e.name);
        this.err(e.line, `undefined name '${e.name}'`);
        return T.any;
      }
      case "Lambda": {
        const paramTypes =
          expected && expected.k === "fun"
            ? e.params.map((_, i) => expected.params[i] ?? T.any)
            : e.params.map(() => T.any);
        const body = new Scope(scope);
        e.params.forEach((p, i) => body.define(p, paramTypes[i]));
        const ret = this.infer(e.body, body, expected && expected.k === "fun" ? expected.ret : undefined);
        return T.fun(paramTypes, ret);
      }
      case "RangeExpr": {
        this.expectNum(e.lo, scope);
        this.expectNum(e.hi, scope);
        return T.list(T.num);
      }
      case "Unary": {
        const t = this.infer(e.operand, scope);
        if (e.op === "!") return T.bool;
        if (!assignable(t, T.num)) this.err(e.line, `unary '-' needs a number, got ${show(t)}`);
        return T.num;
      }
      case "Logical":
        this.infer(e.left, scope);
        this.infer(e.right, scope);
        return T.bool;
      case "Binary":
        return this.inferBinary(e, scope);
      case "Ternary": {
        this.infer(e.cond, scope);
        const a = this.infer(e.then, scope, expected);
        const b = this.infer(e.otherwise, scope, expected);
        return assignable(a, b) || assignable(b, a) ? a : T.any;
      }
      case "Member":
        return this.inferMember(e, scope);
      case "Index":
        return this.inferIndex(e, scope);
      case "Call":
        return this.inferCall(e, scope);
    }
  }

  private expectNum(e: A.Expr, scope: Scope): void {
    const t = this.infer(e, scope);
    if (!assignable(t, T.num)) this.err(e.line, `expected a number, got ${show(t)}`);
  }

  private inferBinary(e: A.Binary, scope: Scope): Type {
    const a = this.infer(e.left, scope);
    const b = this.infer(e.right, scope);
    switch (e.op) {
      case "==":
      case "!=":
        return T.bool;
      case "<":
      case "<=":
      case ">":
      case ">=":
        return T.bool;
      case "+":
        if (a.k === "str" || b.k === "str") return T.str; // string concatenation
        if (assignable(a, T.num) && assignable(b, T.num)) return T.num;
        this.err(e.line, `'+' needs numbers or a string, got ${show(a)} and ${show(b)}`);
        return T.any;
      default: // - * / %
        if (!assignable(a, T.num)) this.err(e.line, `'${e.op}' needs a number, got ${show(a)}`);
        if (!assignable(b, T.num)) this.err(e.line, `'${e.op}' needs a number, got ${show(b)}`);
        return T.num;
    }
  }

  private inferMember(e: A.Member, scope: Scope): Type {
    const ot = this.infer(e.obj, scope);
    if (ot.k === "any" || ot.k === "record") return T.any;
    if (ot.k === "card") {
      const t = CARD_PROPS[e.prop];
      if (t) return t;
      this.err(e.line, `card has no property '${e.prop}'`);
      return T.any;
    }
    if (ot.k === "player") {
      const t = PLAYER_PROPS[e.prop];
      if (t) return t;
      this.err(e.line, `player has no property '${e.prop}'`);
      return T.any;
    }
    this.err(e.line, `${show(ot)} has no properties (.${e.prop})`);
    return T.any;
  }

  private inferIndex(e: A.Index, scope: Scope): Type {
    const ot = this.infer(e.obj, scope);
    const it = this.infer(e.index, scope);
    if (ot.k === "list") {
      if (!assignable(it, T.num)) this.err(e.line, `list index must be a number, got ${show(it)}`);
      return ot.el;
    }
    if (ot.k === "family") {
      if (!assignable(it, T.player) && !assignable(it, T.num)) {
        this.err(e.line, `zone index must be a player, got ${show(it)}`);
      }
      return T.pile;
    }
    if (ot.k === "any") return T.any;
    this.err(e.line, `cannot index ${show(ot)}`);
    return T.any;
  }

  private inferCall(e: A.Call, scope: Scope): Type {
    // builtin?
    if (e.callee.type === "Identifier" && !scope.lookup(e.callee.name)) {
      const sig = BUILTINS.get(e.callee.name);
      if (sig) {
        if ("custom" in sig) return sig.custom(this, e);
        return this.checkFixedCall(e, sig.fixed);
      }
    }
    const ct = this.infer(e.callee, scope);
    if (ct.k === "fun") {
      // user function / lambda value: lenient arg checking, known return type
      e.args.forEach((a, i) => this.infer(a, scope, ct.params[i]));
      return ct.ret;
    }
    if (ct.k === "any") {
      e.args.forEach((a) => this.infer(a, scope));
      return T.any;
    }
    this.err(e.line, `${show(ct)} is not callable`);
    return T.any;
  }

  // checks a call against a fixed function type (with required/rest arity)
  checkFixedCall(e: A.Call, fn: Type): Type {
    if (fn.k !== "fun") return T.any;
    const n = e.args.length;
    if (n < fn.required) {
      this.err(e.line, `expected at least ${fn.required} argument(s), got ${n}`);
    }
    if (!fn.rest && n > fn.params.length) {
      this.err(e.line, `expected at most ${fn.params.length} argument(s), got ${n}`);
    }
    e.args.forEach((arg, i) => {
      const expected = i < fn.params.length ? fn.params[i] : fn.rest ?? T.any;
      const at = this.infer(arg, this.currentScope(arg), expected);
      if (!assignable(at, expected)) {
        this.err(arg.line, `argument ${i + 1}: expected ${show(expected)}, got ${show(at)}`);
      }
    });
    return fn.ret;
  }

  // helper so custom builtins can re-infer an argument with an expected type
  inferArg(call: A.Call, i: number, expected?: Type): Type {
    return this.infer(call.args[i], this.scopeStack[this.scopeStack.length - 1] ?? this.global, expected);
  }

  // The checker walks with an explicit scope, but custom builtins receive only
  // the call node. We keep a small scope stack so they can re-infer arguments.
  private scopeStack: Scope[] = [];
  private currentScope(_n: A.Expr): Scope {
    return this.scopeStack[this.scopeStack.length - 1] ?? this.global;
  }
  pushScope(s: Scope): void {
    this.scopeStack.push(s);
  }
  popScope(): void {
    this.scopeStack.pop();
  }
}

// We need custom builtins to re-infer args in the right scope. Wrap infer so it
// always tracks the active scope on the stack.
const _origInfer = Checker.prototype.infer;
Checker.prototype.infer = function (this: Checker, e: A.Expr, scope: Scope, expected?: Type): Type {
  // @ts-expect-error private access within the same module
  this.scopeStack.push(scope);
  try {
    return _origInfer.call(this, e, scope, expected);
  } finally {
    // @ts-expect-error private access within the same module
    this.scopeStack.pop();
  }
};

// ---- property tables ----
const CARD_PROPS: Record<string, Type> = {
  rank: T.num, suit: T.num, value: T.num, id: T.num,
  color: T.str, rankName: T.str, suitName: T.str, glyph: T.str, label: T.str,
};
const PLAYER_PROPS: Record<string, Type> = {
  id: T.num, name: T.str, out: T.bool, eliminated: T.bool,
};

// ---- builtin signatures ----
function elemOf(t: Type): Type {
  return t.k === "list" ? t.el : T.any;
}

// custom checker for a list+lambda builtin: returns `result(elemType)`
function listLambda(
  paramKind: "bool" | "num" | "any",
  result: (el: Type, ret: Type) => Type,
): (c: Checker, call: A.Call) => Type {
  return (c, call) => {
    const listT = c.inferArg(call, 0);
    const el = elemOf(listT);
    const want = paramKind === "bool" ? T.bool : paramKind === "num" ? T.num : T.any;
    const fnT = c.inferArg(call, 1, T.fun([el], want));
    const ret = fnT.k === "fun" ? fnT.ret : T.any;
    return result(el, ret);
  };
}

const BUILTINS = new Map<string, Sig>();
function fixed(name: string, params: Type[], ret: Type, required = params.length, rest: Type | null = null): void {
  BUILTINS.set(name, { fixed: T.fun(params, ret, required, rest) });
}
function custom(name: string, fn: (c: Checker, call: A.Call) => Type): void {
  BUILTINS.set(name, { custom: fn });
}
function builtinFnType(name: string): Type {
  const s = BUILTINS.get(name);
  if (s && "fixed" in s) return s.fixed;
  return T.fun([], T.any, 0, T.any); // custom builtins: opaque function value
}

// setup / deck
fixed("loadDeck", [T.pile], T.void);
fixed("setValues", [T.fun([T.card], T.num)], T.void);
// players / turns
fixed("others", [T.player], T.list(T.player));
fixed("playerAfter", [T.player], T.player);
fixed("endTurn", [], T.void);
fixed("nextPlayer", [], T.player);
fixed("setCurrent", [T.player], T.void);
fixed("eliminate", [T.player], T.void);
fixed("isActive", [T.player], T.bool);
fixed("active", [], T.list(T.player));
fixed("turnIndex", [], T.num);
fixed("declareWinner", [T.player], T.void);
fixed("declareWinners", [T.list(T.player)], T.void);
fixed("endGame", [], T.void);
// zones / movement
fixed("size", [T.pile], T.num);
fixed("cards", [T.pile], T.list(T.card));
fixed("isEmpty", [T.pile], T.bool);
fixed("top", [T.pile, T.num], T.list(T.card), 1);
fixed("bottom", [T.pile, T.num], T.list(T.card), 1);
fixed("shuffle", [T.pile], T.void);
fixed("move", [T.cardish, T.pile], T.void);
fixed("moveTo", [T.cardish, T.pile, T.str], T.void, 2);
fixed("draw", [T.pile, T.pile, T.num], T.list(T.card), 2);
custom("deal", (c, call) => {
  c.inferArg(call, 0, T.pile);
  const to = c.inferArg(call, 1);
  if (to.k !== "pile" && to.k !== "family" && to.k !== "any") {
    // surface as a generic arg error via checkFixedCall path
    c.checkFixedCall(call, T.fun([T.pile, T.pile, T.num], T.void));
  } else {
    c.inferArg(call, 2, T.num);
  }
  return T.void;
});
// collections
fixed("count", [T.list(T.any)], T.num);
custom("countIf", listLambda("bool", () => T.num));
custom("filter", listLambda("bool", (el) => T.list(el)));
custom("map", listLambda("any", (_el, ret) => T.list(ret)));
custom("any", listLambda("bool", () => T.bool));
custom("all", listLambda("bool", () => T.bool));
custom("none", listLambda("bool", () => T.bool));
custom("sortBy", listLambda("num", (el) => T.list(el)));
custom("maxBy", listLambda("num", (el) => el));
custom("minBy", listLambda("num", (el) => el));
custom("groupBy", listLambda("any", () => T.record));
custom("sum", (c, call) => {
  const listT = c.inferArg(call, 0);
  if (call.args.length > 1) c.inferArg(call, 1, T.fun([elemOf(listT)], T.num));
  return T.num;
});
custom("max", (c, call) => reduceMinMax(c, call));
custom("min", (c, call) => reduceMinMax(c, call));
custom("first", (c, call) => elemOf(c.inferArg(call, 0)));
custom("last", (c, call) => elemOf(c.inferArg(call, 0)));
custom("take", (c, call) => {
  const t = c.inferArg(call, 0);
  c.inferArg(call, 1, T.num);
  return t.k === "list" ? t : T.list(T.any);
});
custom("drop", (c, call) => {
  const t = c.inferArg(call, 0);
  c.inferArg(call, 1, T.num);
  return t.k === "list" ? t : T.list(T.any);
});
custom("reverse", (c, call) => {
  const t = c.inferArg(call, 0);
  return t.k === "list" ? t : T.list(T.any);
});
custom("unique", (c, call) => {
  const t = c.inferArg(call, 0);
  return t.k === "list" ? t : T.list(T.any);
});
custom("concat", (c, call) => {
  const a = c.inferArg(call, 0);
  c.inferArg(call, 1);
  return a.k === "list" ? a : T.list(T.any);
});
custom("contains", (c, call) => {
  c.inferArg(call, 0);
  c.inferArg(call, 1);
  return T.bool;
});
fixed("range", [T.num, T.num], T.list(T.num));
// card helpers
fixed("ranksOf", [T.list(T.card)], T.list(T.num));
fixed("suitsOf", [T.list(T.card)], T.list(T.num));
fixed("sameRank", [T.list(T.card)], T.bool);
fixed("sameSuit", [T.list(T.card)], T.bool);
fixed("isRun", [T.list(T.any), T.bool], T.bool, 1);
fixed("findMelds", [T.list(T.card)], T.list(T.list(T.card)));
fixed("valueOf", [T.card], T.num);
fixed("handValue", [T.list(T.card)], T.num);
fixed("playersWithMax", [T.fun([T.player], T.num)], T.list(T.player));
fixed("playersWithMin", [T.fun([T.player], T.num)], T.list(T.player));
// decisions — the single choice primitive: pick one of `options`, returning its
// element type. Decline is modelled by including `null` among the options.
custom("choose", (c, call) => {
  c.inferArg(call, 0, T.player);
  const opts = c.inferArg(call, 1);
  if (call.args.length > 2) c.inferArg(call, 2, T.str);
  return elemOf(opts);
});
// labeled(value, text): a display wrapper that is transparent to the type
// system — its static type is the wrapped value's type.
custom("labeled", (c, call) => {
  const v = c.inferArg(call, 0);
  if (call.args.length > 1) c.inferArg(call, 1, T.str);
  return v;
});
fixed("rankName", [T.num], T.str);
fixed("suitName", [T.num], T.str);
// misc
fixed("log", [T.any], T.void, 0, T.any);
fixed("announce", [T.any], T.void, 0, T.any);
fixed("rng", [], T.num);
fixed("abs", [T.num], T.num);
fixed("floor", [T.num], T.num);
fixed("ceil", [T.num], T.num);
fixed("round", [T.num], T.num);

function reduceMinMax(c: Checker, call: A.Call): Type {
  if (call.args.length === 1) {
    const t = c.inferArg(call, 0);
    return t.k === "list" ? t.el : T.num;
  }
  const a = c.inferArg(call, 0);
  if (a.k === "list" && call.args.length === 2) {
    c.inferArg(call, 1, T.fun([a.el], T.num));
    return a.el;
  }
  for (let i = 0; i < call.args.length; i++) c.inferArg(call, i, T.num);
  return T.num;
}
