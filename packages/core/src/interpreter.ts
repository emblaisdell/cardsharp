// Generator-based tree-walking interpreter for ♠#.
//
// Evaluation methods are generators so that `choose*` builtins can `yield` a
// ChoiceRequest and the whole call stack suspends until a controller answers.
// Control flow (break/continue/return/endGame) is implemented with thrown
// signals caught at the appropriate boundary.

import type * as A from "./ast.ts";
import {
  Card,
  Player,
  isCallable,
  isList,
  isZoneHandle,
  truthy,
  typeName,
  display,
} from "./values.ts";
import type { Callable, CSValue, ZoneHandle } from "./values.ts";
import { CSRecord } from "./values.ts";
import { GameState } from "./state.ts";
import { makeBuiltins } from "./builtins.ts";
import {
  BreakSignal,
  ContinueSignal,
  GameOver,
  ReturnSignal,
  RuntimeError,
} from "./signals.ts";

const NOT_FOUND = Symbol("not_found");

class Env {
  vars = new Map<string, CSValue>();
  parent: Env | null;
  constructor(parent: Env | null = null) {
    this.parent = parent;
  }

  define(name: string, value: CSValue): void {
    this.vars.set(name, value);
  }
  lookup(name: string): CSValue | typeof NOT_FOUND {
    let e: Env | null = this;
    while (e) {
      if (e.vars.has(name)) return e.vars.get(name) as CSValue;
      e = e.parent;
    }
    return NOT_FOUND;
  }
  assign(name: string, value: CSValue): boolean {
    let e: Env | null = this;
    while (e) {
      if (e.vars.has(name)) {
        e.vars.set(name, value);
        return true;
      }
      e = e.parent;
    }
    return false;
  }
}

export type Eval<T> = Generator<unknown, T, CSValue>;

export class Interpreter {
  state: GameState;
  program: A.Program;
  private global = new Env();
  private dynamic = new Map<string, () => CSValue>();
  private winnersExpr: A.Expr | null = null;
  private hasScore = false;

  constructor(program: A.Program, state: GameState) {
    this.program = program;
    this.state = state;
    this.installGlobals();
  }

  // ---- setup of the global environment ----
  private installGlobals(): void {
    // builtins
    for (const [name, fn] of makeBuiltins(this.state)) {
      this.global.define(name, fn);
    }
    // constants
    const consts: Record<string, CSValue> = {
      Ace: 1, Jack: 11, Queen: 12, King: 13,
      Clubs: 0, Diamonds: 1, Hearts: 2, Spades: 3,
      // unicode suit glyphs as constants (interchangeable with the names)
      "♣": 0, "♦": 1, "♥": 2, "♠": 3,
      ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      suits: [0, 1, 2, 3],
    };
    for (const [k, v] of Object.entries(consts)) this.global.define(k, v);

    // dynamic globals (re-read from state on each access)
    this.dynamic.set("current", () => this.state.current);
    this.dynamic.set("players", () => [...this.state.players]);
    this.dynamic.set("activePlayers", () => this.state.activePlayers());

    // zones
    for (const s of this.program.sections) {
      if (s.type === "ZoneDecl") {
        this.state.defineZone({
          name: s.name,
          perPlayer: s.perPlayer,
          visibility: s.visibility,
          layout: s.layout,
        });
      }
    }
    for (const [name] of this.state.zoneDefs) {
      this.global.define(name, this.state.zoneHandle(name) as ZoneHandle);
    }

    // user functions + score + winners
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

  // ---- public entry ----
  *runGame(): Eval<Player[]> {
    // var declarations (game globals)
    for (const s of this.program.sections) {
      if (s.type === "VarDecl") {
        this.global.define(s.name, yield* this.evalExpr(s.init, this.global));
      }
    }
    // The `deck` decl only records intent; setup materializes cards into a zone
    // via the loadDeck(zone) builtin (supports single- and multi-deck games).
    const setup = this.program.sections.find((s) => s.type === "SetupDecl") as
      | A.SetupDecl
      | undefined;
    const flow = this.program.sections.find((s) => s.type === "FlowDecl") as
      | A.FlowDecl
      | undefined;

    if (setup) yield* this.execBlock(setup.body, new Env(this.global));

    if (flow) {
      try {
        yield* this.execBlock(flow.body, new Env(this.global));
      } catch (e) {
        if (!(e instanceof GameOver)) throw e;
      }
    }
    this.state.ended = true;

    // Winner resolution, in priority order:
    //   1. an explicit declareWinner(s)() call made during play
    //   2. an explicit `winners => …` declaration
    //   3. the default rule: the player(s) with the highest `score` (ties incl.)
    if (!this.state.declaredWinners && this.winnersExpr) {
      const w = yield* this.evalExpr(this.winnersExpr, new Env(this.global));
      this.state.declaredWinners = this.toPlayerList(w);
    } else if (!this.state.declaredWinners && this.hasScore) {
      this.state.declaredWinners = this.winnersByScore();
    }

    // expose game-level variables on the state so external tools (tests, UI,
    // ML feature extractors) can read the final values.
    for (const s of this.program.sections) {
      if (s.type === "VarDecl") {
        const v = this.global.lookup(s.name);
        if (v !== NOT_FOUND) this.state.globals.set(s.name, v as CSValue);
      }
    }
    return this.state.declaredWinners ?? [];
  }

  private toPlayerList(v: CSValue): Player[] {
    if (v instanceof Player) return [v];
    if (isList(v)) return v.filter((x): x is Player => x instanceof Player);
    return [];
  }

  // True if the game declares a `score`. Lets the host (e.g. tree search) know a
  // value heuristic is available.
  get scored(): boolean {
    return this.hasScore;
  }

  // Evaluate the game's `score(player)` synchronously. Score is higher-is-better
  // (may be negative) and is used both as the default winner rule and as a value
  // heuristic for search. Returns 0 if the game declares no score.
  scoreOf(p: Player): number {
    const fn = this.global.lookup("score");
    if (fn === NOT_FOUND || !isCallable(fn)) return 0;
    const gen = fn.invoke([p]);
    let r = gen.next();
    while (!r.done) r = gen.next(null); // score must not make choices
    return typeof r.value === "number" ? r.value : 0;
  }

  private winnersByScore(): Player[] {
    const players = this.state.players;
    if (players.length === 0) return [];
    const scores = players.map((p) => this.scoreOf(p));
    const best = Math.max(...scores);
    return players.filter((_, i) => scores[i] === best);
  }

  // ---- callables ----
  private makeFunction(name: string, params: string[], body: A.Block, closure: Env): Callable {
    const self = this;
    return {
      call: true,
      name,
      *invoke(args: CSValue[]): Eval<CSValue> {
        const env = new Env(closure);
        params.forEach((p, i) => env.define(p, args[i] ?? null));
        try {
          yield* self.execBlock(body, env);
        } catch (e) {
          if (e instanceof ReturnSignal) return e.value;
          throw e;
        }
        return null;
      },
    };
  }

  private makeExprFunction(name: string, params: string[], expr: A.Expr, closure: Env): Callable {
    const self = this;
    return {
      call: true,
      name,
      *invoke(args: CSValue[]): Eval<CSValue> {
        const env = new Env(closure);
        params.forEach((p, i) => env.define(p, args[i] ?? null));
        return yield* self.evalExpr(expr, env);
      },
    };
  }

  // ---- statements ----
  private *execBlock(block: A.Block, env: Env): Eval<void> {
    const scope = new Env(env);
    for (const stmt of block.stmts) {
      yield* this.execStmt(stmt, scope);
    }
  }

  private *execStmt(stmt: A.Stmt, env: Env): Eval<void> {
    switch (stmt.type) {
      case "Block":
        yield* this.execBlock(stmt, env);
        return;
      case "VarStmt":
        env.define(stmt.name, yield* this.evalExpr(stmt.init, env));
        return;
      case "AssignStmt":
        yield* this.execAssign(stmt, env);
        return;
      case "ExprStmt":
        yield* this.evalExpr(stmt.expr, env);
        return;
      case "IfStmt": {
        if (truthy(yield* this.evalExpr(stmt.cond, env))) {
          yield* this.execBlock(stmt.then, env);
        } else if (stmt.otherwise) {
          if (stmt.otherwise.type === "IfStmt") yield* this.execStmt(stmt.otherwise, env);
          else yield* this.execBlock(stmt.otherwise, env);
        }
        return;
      }
      case "WhileStmt":
        while (truthy(yield* this.evalExpr(stmt.cond, env))) {
          try {
            yield* this.execBlock(stmt.body, env);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      case "LoopStmt":
        for (;;) {
          try {
            yield* this.execBlock(stmt.body, env);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      case "RepeatStmt": {
        const n = this.num(yield* this.evalExpr(stmt.count, env), stmt.line);
        for (let i = 0; i < n; i++) {
          try {
            yield* this.execBlock(stmt.body, env);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case "ForStmt": {
        const iter = yield* this.evalExpr(stmt.iter, env);
        if (!isList(iter)) {
          throw new RuntimeError(`for-in expects a list, got ${typeName(iter)}`, stmt.line);
        }
        for (const item of [...iter]) {
          const scope = new Env(env);
          scope.define(stmt.name, item);
          try {
            yield* this.execBlock(stmt.body, scope);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case "BreakStmt":
        throw new BreakSignal();
      case "ContinueStmt":
        throw new ContinueSignal();
      case "ReturnStmt":
        throw new ReturnSignal(stmt.expr ? yield* this.evalExpr(stmt.expr, env) : null);
    }
  }

  private *execAssign(stmt: A.AssignStmt, env: Env): Eval<void> {
    const value = yield* this.evalExpr(stmt.value, env);
    const t = stmt.target;
    if (t.type === "Identifier") {
      if (!env.assign(t.name, value)) {
        throw new RuntimeError(`assignment to undeclared variable '${t.name}'`, stmt.line);
      }
      return;
    }
    if (t.type === "Member") {
      const obj = yield* this.evalExpr(t.obj, env);
      if (obj instanceof Card && t.prop === "value") {
        obj.value = this.num(value, stmt.line);
        return;
      }
      if (obj instanceof Player && t.prop === "name") {
        obj.name = String(value);
        return;
      }
      throw new RuntimeError(`cannot assign to ${typeName(obj)}.${t.prop}`, stmt.line);
    }
    if (t.type === "Index") {
      const obj = yield* this.evalExpr(t.obj, env);
      const idx = yield* this.evalExpr(t.index, env);
      if (isList(obj) && typeof idx === "number") {
        obj[idx] = value;
        return;
      }
      throw new RuntimeError(`invalid index assignment`, stmt.line);
    }
  }

  // ---- expressions ----
  private *evalExpr(expr: A.Expr, env: Env): Eval<CSValue> {
    switch (expr.type) {
      case "NumberLit":
        return expr.value;
      case "StringLit":
        return expr.value;
      case "BoolLit":
        return expr.value;
      case "NullLit":
        return null;
      case "ListLit": {
        const out: CSValue[] = [];
        for (const el of expr.elements) out.push(yield* this.evalExpr(el, env));
        return out;
      }
      case "RecordLit": {
        const rec = new CSRecord();
        for (const e of expr.entries) rec.set(e.key, yield* this.evalExpr(e.value, env));
        return rec;
      }
      case "Identifier": {
        const v = env.lookup(expr.name);
        if (v !== NOT_FOUND) return v;
        const dyn = this.dynamic.get(expr.name);
        if (dyn) return dyn();
        throw new RuntimeError(`undefined name '${expr.name}'`, expr.line);
      }
      case "Lambda":
        return this.makeExprFunction("lambda", expr.params, expr.body, env);
      case "RangeExpr": {
        const lo = this.num(yield* this.evalExpr(expr.lo, env), expr.line);
        const hi = this.num(yield* this.evalExpr(expr.hi, env), expr.line);
        const out: CSValue[] = [];
        for (let i = lo; i <= hi; i++) out.push(i);
        return out;
      }
      case "Unary": {
        const v = yield* this.evalExpr(expr.operand, env);
        if (expr.op === "!") return !truthy(v);
        return -this.num(v, expr.line);
      }
      case "Logical": {
        const l = yield* this.evalExpr(expr.left, env);
        if (expr.op === "&&") return truthy(l) ? truthy(yield* this.evalExpr(expr.right, env)) : false;
        return truthy(l) ? true : truthy(yield* this.evalExpr(expr.right, env));
      }
      case "Binary":
        return yield* this.evalBinary(expr, env);
      case "Ternary":
        return truthy(yield* this.evalExpr(expr.cond, env))
          ? yield* this.evalExpr(expr.then, env)
          : yield* this.evalExpr(expr.otherwise, env);
      case "Member": {
        const obj = yield* this.evalExpr(expr.obj, env);
        return this.getProp(obj, expr.prop, expr.line);
      }
      case "Index": {
        const obj = yield* this.evalExpr(expr.obj, env);
        const idx = yield* this.evalExpr(expr.index, env);
        return this.getIndex(obj, idx, expr.line);
      }
      case "Call": {
        const callee = yield* this.evalExpr(expr.callee, env);
        const args: CSValue[] = [];
        for (const a of expr.args) args.push(yield* this.evalExpr(a, env));
        if (!isCallable(callee)) {
          throw new RuntimeError(`'${display(callee)}' is not callable`, expr.line);
        }
        return yield* callee.invoke(args) as Eval<CSValue>;
      }
    }
  }

  private *evalBinary(expr: A.Binary, env: Env): Eval<CSValue> {
    const a = yield* this.evalExpr(expr.left, env);
    const b = yield* this.evalExpr(expr.right, env);
    switch (expr.op) {
      case "==":
        return this.equals(a, b);
      case "!=":
        return !this.equals(a, b);
      case "+":
        if (typeof a === "string" || typeof b === "string") return display(a) + display(b);
        return this.num(a, expr.line) + this.num(b, expr.line);
      case "-":
        return this.num(a, expr.line) - this.num(b, expr.line);
      case "*":
        return this.num(a, expr.line) * this.num(b, expr.line);
      case "/":
        return this.num(a, expr.line) / this.num(b, expr.line);
      case "%":
        return this.num(a, expr.line) % this.num(b, expr.line);
      case "<":
      case "<=":
      case ">":
      case ">=":
        return this.compare(a, b, expr.op, expr.line);
    }
    throw new RuntimeError(`unknown operator ${expr.op}`, expr.line);
  }

  private equals(a: CSValue, b: CSValue): boolean {
    if (a === b) return true;
    if (a instanceof Card && b instanceof Card) return a.id === b.id;
    if (a instanceof Player && b instanceof Player) return a.id === b.id;
    return false;
  }

  private compare(a: CSValue, b: CSValue, op: string, line: number): boolean {
    let x: number, y: number;
    if (typeof a === "string" && typeof b === "string") {
      x = a < b ? -1 : a > b ? 1 : 0;
      y = 0;
    } else {
      x = this.num(a, line);
      y = this.num(b, line);
    }
    switch (op) {
      case "<":
        return x < y;
      case "<=":
        return x <= y;
      case ">":
        return x > y;
      case ">=":
        return x >= y;
    }
    return false;
  }

  private getProp(obj: CSValue, prop: string, line: number): CSValue {
    if (obj instanceof Card) {
      switch (prop) {
        case "rank": return obj.rank;
        case "suit": return obj.suit;
        case "value": return obj.value;
        case "id": return obj.id;
        case "color": return obj.color;
        case "rankName": return obj.rankName;
        case "suitName": return obj.suitName;
        case "glyph": return obj.glyph;
        case "label": return obj.label;
      }
    }
    if (obj instanceof Player) {
      switch (prop) {
        case "id": return obj.id;
        case "name": return obj.name;
        case "out":
        case "eliminated": return obj.eliminated;
      }
    }
    if (obj instanceof CSRecord) return obj.get(prop);
    throw new RuntimeError(`no property '${prop}' on ${typeName(obj)}`, line);
  }

  private getIndex(obj: CSValue, idx: CSValue, line: number): CSValue {
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

  private num(v: CSValue, line: number): number {
    if (typeof v !== "number") {
      throw new RuntimeError(`expected a number, got ${typeName(v)}`, line);
    }
    return v;
  }
}
