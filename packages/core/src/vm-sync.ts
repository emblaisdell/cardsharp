// Synchronous evaluator for ♠# — the same language semantics as interpreter.ts
// but plain recursion instead of generators. Choices are answered by a
// synchronous `decide` callback (used for rollouts and for lambda bodies, which
// never choose). This is Layer 1 of the resumable engine: it is exercised by an
// equivalence test against the generator interpreter, and it underpins the
// resumable stepper (Layer 2) and fair-search rollouts.

import type * as A from "./ast.ts";
import {
  Card, Player, CSRecord,
  isCallable, isList, isZoneHandle, truthy, typeName, display,
} from "./values.ts";
import type { Callable, CSValue, ZoneHandle } from "./values.ts";
import { GameState } from "./state.ts";
import { makeBuiltins } from "./builtins.ts";
import { BreakSignal, ContinueSignal, GameOver, ReturnSignal, RuntimeError } from "./signals.ts";
import type { ChoiceRequest } from "./choice.ts";

const NOT_FOUND = Symbol("nf");

export class SyncEnv {
  vars = new Map<string, CSValue>();
  parent: SyncEnv | null;
  constructor(parent: SyncEnv | null = null) {
    this.parent = parent;
  }
  define(n: string, v: CSValue): void {
    this.vars.set(n, v);
  }
  lookup(n: string): CSValue | typeof NOT_FOUND {
    let e: SyncEnv | null = this;
    while (e) {
      if (e.vars.has(n)) return e.vars.get(n) as CSValue;
      e = e.parent;
    }
    return NOT_FOUND;
  }
  assign(n: string, v: CSValue): boolean {
    let e: SyncEnv | null = this;
    while (e) {
      if (e.vars.has(n)) {
        e.vars.set(n, v);
        return true;
      }
      e = e.parent;
    }
    return false;
  }
}

// A controller answers a choice synchronously during sync evaluation.
export type Decide = (req: ChoiceRequest) => CSValue;

export class SyncInterp {
  state: GameState;
  program: A.Program;
  decide: Decide;
  protected global = new SyncEnv();
  protected dynamic = new Map<string, () => CSValue>();
  protected winnersExpr: A.Expr | null = null;
  protected hasScore = false;
  protected builtins: Map<string, Callable>;

  constructor(program: A.Program, state: GameState, decide: Decide, opts?: { skipZones?: boolean }) {
    this.program = program;
    this.state = state;
    this.decide = decide;
    this.builtins = makeBuiltins(state);
    this.installGlobals(opts?.skipZones ?? false);
  }

  // skipZones: the GameState already has its zones/piles (e.g. a clone) — bind
  // names to the existing handles instead of re-creating piles.
  protected installGlobals(skipZones: boolean): void {
    for (const [name, fn] of this.builtins) this.global.define(name, fn);
    const consts: Record<string, CSValue> = {
      Ace: 1, Jack: 11, Queen: 12, King: 13,
      Clubs: 0, Diamonds: 1, Hearts: 2, Spades: 3,
      "♣": 0, "♦": 1, "♥": 2, "♠": 3,
      ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      suits: [0, 1, 2, 3],
    };
    for (const [k, v] of Object.entries(consts)) this.global.define(k, v);
    this.dynamic.set("current", () => this.state.current);
    this.dynamic.set("players", () => [...this.state.players]);
    this.dynamic.set("activePlayers", () => this.state.activePlayers());

    if (!skipZones) {
      for (const s of this.program.sections) {
        if (s.type === "ZoneDecl") {
          this.state.defineZone({
            name: s.name, perPlayer: s.perPlayer, visibility: s.visibility, layout: s.layout,
          });
        }
      }
    }
    for (const [name] of this.state.zoneDefs) {
      this.global.define(name, this.state.zoneHandle(name) as ZoneHandle);
    }
    for (const s of this.program.sections) {
      if (s.type === "FunctionDecl") {
        this.global.define(s.name, this.makeFunction(s.name, s.params, s.body, this.global));
      } else if (s.type === "ScoreDecl") {
        this.global.define("score", this.makeExprFunction("score", [s.param], s.expr, this.global));
        this.hasScore = true;
      } else if (s.type === "WinnersDecl") {
        this.winnersExpr = s.expr;
      }
    }
  }

  // ---- public entry: run the whole game synchronously ----
  run(): Player[] {
    for (const s of this.program.sections) {
      if (s.type === "VarDecl") this.global.define(s.name, this.evalExpr(s.init, this.global));
    }
    const setup = this.program.sections.find((s) => s.type === "SetupDecl") as A.SetupDecl | undefined;
    const flow = this.program.sections.find((s) => s.type === "FlowDecl") as A.FlowDecl | undefined;
    if (setup) this.execBlock(setup.body, new SyncEnv(this.global));
    if (flow) {
      try {
        this.execBlock(flow.body, new SyncEnv(this.global));
      } catch (e) {
        if (!(e instanceof GameOver)) throw e;
      }
    }
    this.state.ended = true;
    if (!this.state.declaredWinners && this.winnersExpr) {
      this.state.declaredWinners = this.toPlayers(this.evalExpr(this.winnersExpr, new SyncEnv(this.global)));
    } else if (!this.state.declaredWinners && this.hasScore) {
      this.state.declaredWinners = this.winnersByScore();
    }
    for (const s of this.program.sections) {
      if (s.type === "VarDecl") {
        const v = this.global.lookup(s.name);
        if (v !== NOT_FOUND) this.state.globals.set(s.name, v as CSValue);
      }
    }
    return this.state.declaredWinners ?? [];
  }

  scoreOf(p: Player): number {
    return this.callScore(p);
  }

  protected winnersByScore(): Player[] {
    const ps = this.state.players;
    if (!ps.length) return [];
    const sc = ps.map((p) => this.callScore(p));
    const best = Math.max(...sc);
    return ps.filter((_, i) => sc[i] === best);
  }
  protected callScore(p: Player): number {
    const fn = this.global.lookup("score");
    if (fn === NOT_FOUND || !isCallable(fn)) return 0;
    const v = this.callValue(fn, [p]);
    return typeof v === "number" ? v : 0;
  }

  protected toPlayers(v: CSValue): Player[] {
    if (v instanceof Player) return [v];
    if (isList(v)) return v.filter((x): x is Player => x instanceof Player);
    return [];
  }

  // ---- callables ----
  protected makeFunction(name: string, params: string[], body: A.Block, closure: SyncEnv): Callable {
    const self = this;
    return {
      call: true,
      name,
      *invoke(args: CSValue[]) {
        const env = new SyncEnv(closure);
        params.forEach((p, i) => env.define(p, args[i] ?? null));
        try {
          self.execBlock(body, env);
        } catch (e) {
          if (e instanceof ReturnSignal) return e.value;
          throw e;
        }
        return null;
      },
    };
  }
  protected makeExprFunction(name: string, params: string[], expr: A.Expr, closure: SyncEnv): Callable {
    const self = this;
    return {
      call: true,
      name,
      *invoke(args: CSValue[]) {
        const env = new SyncEnv(closure);
        params.forEach((p, i) => env.define(p, args[i] ?? null));
        return self.evalExpr(expr, env);
      },
    };
  }
  // drive a callable's generator to completion synchronously (lambdas/user fns
  // never suspend); pure builtins may, but only the choose* ones, handled below.
  protected callValue(fn: CSValue, args: CSValue[]): CSValue {
    if (!isCallable(fn)) throw new RuntimeError(`'${display(fn)}' is not callable`);
    const gen = fn.invoke(args) as Generator<unknown, CSValue, CSValue>;
    let r = gen.next();
    while (!r.done) {
      // a builtin yielded a ChoiceRequest — answer it synchronously
      r = gen.next(this.decide(r.value as ChoiceRequest));
    }
    return r.value;
  }

  // ---- statements ----
  protected execBlock(block: A.Block, env: SyncEnv): void {
    const scope = new SyncEnv(env);
    for (const st of block.stmts) this.execStmt(st, scope);
  }
  protected execStmt(stmt: A.Stmt, env: SyncEnv): void {
    switch (stmt.type) {
      case "Block": this.execBlock(stmt, env); return;
      case "VarStmt": env.define(stmt.name, this.evalExpr(stmt.init, env)); return;
      case "AssignStmt": this.execAssign(stmt, env); return;
      case "ExprStmt": this.evalExpr(stmt.expr, env); return;
      case "IfStmt": {
        if (truthy(this.evalExpr(stmt.cond, env))) this.execBlock(stmt.then, env);
        else if (stmt.otherwise) {
          if (stmt.otherwise.type === "IfStmt") this.execStmt(stmt.otherwise, env);
          else this.execBlock(stmt.otherwise, env);
        }
        return;
      }
      case "WhileStmt":
        while (truthy(this.evalExpr(stmt.cond, env))) {
          try { this.execBlock(stmt.body, env); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      case "LoopStmt":
        for (;;) {
          try { this.execBlock(stmt.body, env); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      case "RepeatStmt": {
        const n = this.num(this.evalExpr(stmt.count, env), stmt.line);
        for (let i = 0; i < n; i++) {
          try { this.execBlock(stmt.body, env); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      }
      case "ForStmt": {
        const it = this.evalExpr(stmt.iter, env);
        if (!isList(it)) throw new RuntimeError(`for-in expects a list, got ${typeName(it)}`, stmt.line);
        for (const item of [...it]) {
          const scope = new SyncEnv(env);
          scope.define(stmt.name, item);
          try { this.execBlock(stmt.body, scope); }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      }
      case "BreakStmt": throw new BreakSignal();
      case "ContinueStmt": throw new ContinueSignal();
      case "ReturnStmt": throw new ReturnSignal(stmt.expr ? this.evalExpr(stmt.expr, env) : null);
    }
  }
  protected execAssign(stmt: A.AssignStmt, env: SyncEnv): void {
    const value = this.evalExpr(stmt.value, env);
    const t = stmt.target;
    if (t.type === "Identifier") {
      if (!env.assign(t.name, value)) throw new RuntimeError(`assignment to undeclared variable '${t.name}'`, stmt.line);
      return;
    }
    if (t.type === "Member") {
      const obj = this.evalExpr(t.obj, env);
      if (obj instanceof Card && t.prop === "value") { obj.value = this.num(value, stmt.line); return; }
      if (obj instanceof Player && t.prop === "name") { obj.name = String(value); return; }
      throw new RuntimeError(`cannot assign to ${typeName(obj)}.${t.prop}`, stmt.line);
    }
    if (t.type === "Index") {
      const obj = this.evalExpr(t.obj, env);
      const idx = this.evalExpr(t.index, env);
      if (isList(obj) && typeof idx === "number") { obj[idx] = value; return; }
      throw new RuntimeError("invalid index assignment", stmt.line);
    }
  }

  // ---- expressions ----
  evalExpr(expr: A.Expr, env: SyncEnv): CSValue {
    switch (expr.type) {
      case "NumberLit": return expr.value;
      case "StringLit": return expr.value;
      case "BoolLit": return expr.value;
      case "NullLit": return null;
      case "ListLit": return expr.elements.map((el) => this.evalExpr(el, env));
      case "RecordLit": {
        const rec = new CSRecord();
        for (const e of expr.entries) rec.set(e.key, this.evalExpr(e.value, env));
        return rec;
      }
      case "Identifier": {
        const v = env.lookup(expr.name);
        if (v !== NOT_FOUND) return v;
        const dyn = this.dynamic.get(expr.name);
        if (dyn) return dyn();
        throw new RuntimeError(`undefined name '${expr.name}'`, expr.line);
      }
      case "Lambda": return this.makeExprFunction("lambda", expr.params, expr.body, env);
      case "RangeExpr": {
        const lo = this.num(this.evalExpr(expr.lo, env), expr.line);
        const hi = this.num(this.evalExpr(expr.hi, env), expr.line);
        const out: CSValue[] = [];
        for (let i = lo; i <= hi; i++) out.push(i);
        return out;
      }
      case "Unary": {
        const v = this.evalExpr(expr.operand, env);
        return expr.op === "!" ? !truthy(v) : -this.num(v, expr.line);
      }
      case "Logical": {
        const l = this.evalExpr(expr.left, env);
        if (expr.op === "&&") return truthy(l) ? truthy(this.evalExpr(expr.right, env)) : false;
        return truthy(l) ? true : truthy(this.evalExpr(expr.right, env));
      }
      case "Binary": return this.evalBinary(expr, env);
      case "Ternary":
        return truthy(this.evalExpr(expr.cond, env)) ? this.evalExpr(expr.then, env) : this.evalExpr(expr.otherwise, env);
      case "Member": return this.getProp(this.evalExpr(expr.obj, env), expr.prop, expr.line);
      case "Index": return this.getIndex(this.evalExpr(expr.obj, env), this.evalExpr(expr.index, env), expr.line);
      case "Call": {
        const callee = this.evalExpr(expr.callee, env);
        const args = expr.args.map((a) => this.evalExpr(a, env));
        return this.callValue(callee, args);
      }
    }
  }
  protected evalBinary(expr: A.Binary, env: SyncEnv): CSValue {
    return this.applyBinary(expr.op, this.evalExpr(expr.left, env), this.evalExpr(expr.right, env), expr.line);
  }
  // value-level binary op, reused by the resumable stepper
  protected applyBinary(op: string, a: CSValue, b: CSValue, line: number): CSValue {
    switch (op) {
      case "==": return this.equals(a, b);
      case "!=": return !this.equals(a, b);
      case "+":
        if (typeof a === "string" || typeof b === "string") return display(a) + display(b);
        return this.num(a, line) + this.num(b, line);
      case "-": return this.num(a, line) - this.num(b, line);
      case "*": return this.num(a, line) * this.num(b, line);
      case "/": return this.num(a, line) / this.num(b, line);
      case "%": return this.num(a, line) % this.num(b, line);
      case "<": case "<=": case ">": case ">=": return this.compare(a, b, op, line);
    }
    throw new RuntimeError(`unknown operator ${op}`, line);
  }
  protected equals(a: CSValue, b: CSValue): boolean {
    if (a === b) return true;
    if (a instanceof Card && b instanceof Card) return a.id === b.id;
    if (a instanceof Player && b instanceof Player) return a.id === b.id;
    return false;
  }
  protected compare(a: CSValue, b: CSValue, op: string, line: number): boolean {
    let x: number, y: number;
    if (typeof a === "string" && typeof b === "string") { x = a < b ? -1 : a > b ? 1 : 0; y = 0; }
    else { x = this.num(a, line); y = this.num(b, line); }
    switch (op) { case "<": return x < y; case "<=": return x <= y; case ">": return x > y; case ">=": return x >= y; }
    return false;
  }
  protected getProp(obj: CSValue, prop: string, line: number): CSValue {
    if (obj instanceof Card) {
      switch (prop) {
        case "rank": return obj.rank; case "suit": return obj.suit; case "value": return obj.value;
        case "id": return obj.id; case "color": return obj.color; case "rankName": return obj.rankName;
        case "suitName": return obj.suitName; case "glyph": return obj.glyph; case "label": return obj.label;
      }
    }
    if (obj instanceof Player) {
      switch (prop) {
        case "id": return obj.id; case "name": return obj.name;
        case "out": case "eliminated": return obj.eliminated;
      }
    }
    if (obj instanceof CSRecord) return obj.get(prop);
    throw new RuntimeError(`no property '${prop}' on ${typeName(obj)}`, line);
  }
  protected getIndex(obj: CSValue, idx: CSValue, line: number): CSValue {
    if (isList(obj)) {
      if (typeof idx !== "number") throw new RuntimeError("list index must be a number", line);
      const v = obj[idx];
      return v === undefined ? null : v;
    }
    if (isZoneHandle(obj) && obj.zone === "family") {
      if (idx instanceof Player) return { zone: "pile", pile: obj.piles[idx.id] };
      if (typeof idx === "number") return { zone: "pile", pile: obj.piles[idx] };
      throw new RuntimeError("zone index must be a player", line);
    }
    throw new RuntimeError(`cannot index ${typeName(obj)}`, line);
  }
  protected num(v: CSValue, line: number): number {
    if (typeof v !== "number") throw new RuntimeError(`expected a number, got ${typeName(v)}`, line);
    return v;
  }
}

// Run a whole game synchronously to completion, answering choices via `decide`.
// This is the rollout/playout primitive and the equivalence reference.
export function runToCompletion(program: A.Program, state: GameState, decide: Decide): Player[] {
  return new SyncInterp(program, state, decide).run();
}
