// Resumable, cloneable stepper for ♠# (Layer 2 of the engine).
//
// It runs a game as an explicit machine that suspends at every `choose` and
// whose entire state — control stack, value stack, environments, GameState — is
// cloneable. Non-choosing subtrees run on the validated synchronous evaluator
// (SyncInterp); only the "choosing spine" (paths to a `choose`) is decomposed
// onto the explicit stack, so the stepper stays small. This is what fair
// information-set MCTS needs: clone the machine at a decision, determinize the
// clone, and roll out.
//
// Key invariant that keeps cloning simple: no closure is ever stored in a live
// local across a decision in these games (lambdas are transient builtin args;
// user functions live in the shared global env), so the cloned continuation
// only ever holds primitives, Cards (shared), Players (remapped), lists, and
// zone handles (re-resolved) — never a closure.

import type * as A from "./ast.ts";
import { SyncInterp, SyncEnv } from "./vm-sync.ts";
import type { Decide } from "./vm-sync.ts";
import {
  Card, Player, Labeled, CSRecord,
  isZoneHandle, isCallable, truthy, unwrap,
} from "./values.ts";
import type { Callable, CSValue } from "./values.ts";
import { GameState } from "./state.ts";
import { GameOver, BreakSignal, ContinueSignal, ReturnSignal, RuntimeError } from "./signals.ts";
import type { ChoiceRequest } from "./choice.ts";

type Completion = "normal" | "break" | "continue" | "return";
// A control frame. `t` is the tag; other fields depend on it. Nodes are shared
// (immutable AST); `env` is a SyncEnv; `items` is a list of values.
interface Frame {
  t: string;
  node?: A.Stmt | A.Expr;
  env?: SyncEnv;
  op?: string;
  line?: number;
  n?: number;
  idx?: number;
  name?: string;
  prop?: string;
  keys?: string[];
  items?: CSValue[];
  thenN?: A.Stmt | A.Expr;
  elseN?: A.Stmt | A.Expr | null;
  rightN?: A.Expr;
  target?: A.Expr;
  stmts?: A.Stmt[];
}

export interface StepResult {
  done: boolean;
  request?: ChoiceRequest;
  winners?: Player[];
}

export class Machine extends SyncInterp {
  private K: Frame[] = [];
  private V: CSValue[] = [];
  private completion: Completion = "normal";
  private retval: CSValue = null;
  private pending: ChoiceRequest | null = null;
  private finished = false;
  private winners: Player[] = [];

  private funcChooses = new Map<string, boolean>();
  private mcCache = new Map<A.Stmt | A.Expr, boolean>();

  constructor(program: A.Program, state: GameState, decide: Decide, opts?: { skipZones?: boolean }) {
    super(program, state, decide, opts);
    this.computeChooses();
  }

  // tag user-function/lambda closures with the raw bits the stepper needs
  protected makeFunction(name: string, params: string[], body: A.Block, closure: SyncEnv): Callable {
    const fn = super.makeFunction(name, params, body, closure) as Callable & Record<string, unknown>;
    fn.userFn = true;
    fn.kind = "fn";
    fn.params = params;
    fn.body = body;
    fn.cenv = closure;
    return fn;
  }
  protected makeExprFunction(name: string, params: string[], expr: A.Expr, closure: SyncEnv): Callable {
    const fn = super.makeExprFunction(name, params, expr, closure) as Callable & Record<string, unknown>;
    fn.userFn = true;
    fn.kind = "expr";
    fn.params = params;
    fn.body = expr;
    fn.cenv = closure;
    return fn;
  }

  // ---- public driving interface ----
  // Begin the game: run var decls + setup synchronously (these never choose),
  // then arm the flow block on the control stack.
  start(): StepResult {
    for (const s of this.program.sections) {
      if (s.type === "VarDecl") this.global.define(s.name, this.evalExpr(s.init, this.global));
    }
    const setup = this.program.sections.find((s) => s.type === "SetupDecl") as A.SetupDecl | undefined;
    const flow = this.program.sections.find((s) => s.type === "FlowDecl") as A.FlowDecl | undefined;
    if (setup) {
      try {
        this.execBlock(setup.body, new SyncEnv(this.global));
      } catch (e) {
        if (!(e instanceof GameOver)) throw e;
      }
    }
    this.K = flow ? [{ t: "ES", node: flow.body, env: new SyncEnv(this.global) }] : [];
    return this.next();
  }

  // Drive until the next decision (returns its request) or game end.
  next(): StepResult {
    if (this.finished) return { done: true, winners: this.winners };
    if (this.pending) return { done: false, request: this.pending };
    try {
      while (this.K.length) {
        this.step();
        if (this.pending) return { done: false, request: this.pending };
      }
    } catch (e) {
      if (!(e instanceof GameOver)) throw e;
    }
    return this.finish();
  }

  // Answer the pending decision; then call next() to continue.
  supply(answer: CSValue): void {
    if (!this.pending) throw new RuntimeError("supply() with no pending choice");
    const opts = this.pending.options;
    if (!opts.some((o) => sameValue(o, answer))) {
      throw new RuntimeError(`controller chose an illegal option`);
    }
    this.V.push(unwrap(answer));
    this.pending = null;
  }

  get currentRequest(): ChoiceRequest | null {
    return this.pending;
  }
  get isDone(): boolean {
    return this.finished;
  }

  private finish(): StepResult {
    this.state.ended = true;
    if (!this.state.declaredWinners && this.winnersExpr) {
      this.state.declaredWinners = this.toPlayers(this.evalExpr(this.winnersExpr, new SyncEnv(this.global)));
    } else if (!this.state.declaredWinners && this.hasScore) {
      this.state.declaredWinners = this.winnersByScore();
    }
    this.winners = this.state.declaredWinners ?? [];
    this.finished = true;
    return { done: true, winners: this.winners };
  }

  // ---- the step ----
  private push(fr: Frame): void {
    this.K.push(fr);
  }
  private step(): void {
    const fr = this.K.pop() as Frame;
    switch (fr.t) {
      // ===== statements =====
      case "ES": return this.execStep(fr.node as A.Stmt, fr.env as SyncEnv);
      case "SEQ": {
        if (this.completion !== "normal") return;
        if ((fr.idx as number) >= (fr.stmts as A.Stmt[]).length) return;
        this.push({ t: "SEQ", stmts: fr.stmts, env: fr.env, idx: (fr.idx as number) + 1 });
        this.push({ t: "ES", node: (fr.stmts as A.Stmt[])[fr.idx as number], env: fr.env });
        return;
      }
      case "IFB": {
        const cond = this.V.pop();
        if (truthy(cond as CSValue)) this.push({ t: "ES", node: fr.thenN as A.Stmt, env: fr.env });
        else if (fr.elseN) this.push({ t: "ES", node: fr.elseN as A.Stmt, env: fr.env });
        return;
      }
      case "WHILE":
        this.push({ t: "WHILEC", node: fr.node, env: fr.env });
        this.push({ t: "EE", node: (fr.node as A.WhileStmt).cond, env: fr.env });
        return;
      case "WHILEC": {
        if (!truthy(this.V.pop() as CSValue)) return;
        this.push({ t: "LOOPAFTER", node: fr.node, env: fr.env, op: "while" });
        this.push({ t: "ES", node: (fr.node as A.WhileStmt).body, env: fr.env });
        return;
      }
      case "LOOP":
        this.push({ t: "LOOPAFTER", node: fr.node, env: fr.env, op: "loop" });
        this.push({ t: "ES", node: (fr.node as A.LoopStmt).body, env: fr.env });
        return;
      case "LOOPAFTER": {
        const c = this.completion;
        if (c === "break") { this.completion = "normal"; return; }
        if (c === "return") return;
        if (c === "continue") this.completion = "normal";
        // normal or continue → iterate again
        if (fr.op === "while") this.push({ t: "WHILE", node: fr.node, env: fr.env });
        else this.push({ t: "LOOP", node: fr.node, env: fr.env });
        return;
      }
      case "FORSTART": {
        const items = this.V.pop();
        if (!Array.isArray(items)) throw new RuntimeError("for-in expects a list");
        this.push({ t: "FOR", items, idx: 0, name: (fr.node as A.ForStmt).name, node: fr.node, env: fr.env });
        return;
      }
      case "FOR": {
        const items = fr.items as CSValue[];
        if ((fr.idx as number) >= items.length) return;
        const scope = new SyncEnv(fr.env as SyncEnv);
        scope.define(fr.name as string, items[fr.idx as number]);
        this.push({ t: "FORAFTER", items, idx: fr.idx, name: fr.name, node: fr.node, env: fr.env });
        this.push({ t: "ES", node: (fr.node as A.ForStmt).body, env: scope });
        return;
      }
      case "FORAFTER": {
        const c = this.completion;
        if (c === "break") { this.completion = "normal"; return; }
        if (c === "return") return;
        if (c === "continue") this.completion = "normal";
        this.push({ t: "FOR", items: fr.items, idx: (fr.idx as number) + 1, name: fr.name, node: fr.node, env: fr.env });
        return;
      }
      case "REPSTART": {
        const n = this.num(this.V.pop() as CSValue, fr.line as number);
        this.push({ t: "REP", n, idx: 0, node: fr.node, env: fr.env });
        return;
      }
      case "REP": {
        if ((fr.idx as number) >= (fr.n as number)) return;
        this.push({ t: "REPAFTER", n: fr.n, idx: fr.idx, node: fr.node, env: fr.env });
        this.push({ t: "ES", node: (fr.node as A.RepeatStmt).body, env: new SyncEnv(fr.env as SyncEnv) });
        return;
      }
      case "REPAFTER": {
        const c = this.completion;
        if (c === "break") { this.completion = "normal"; return; }
        if (c === "return") return;
        if (c === "continue") this.completion = "normal";
        this.push({ t: "REP", n: fr.n, idx: (fr.idx as number) + 1, node: fr.node, env: fr.env });
        return;
      }
      case "VARDEF": (fr.env as SyncEnv).define(fr.name as string, this.V.pop() as CSValue); return;
      case "ASSIGN": return this.doAssign(fr.target as A.Expr, fr.env as SyncEnv, this.V.pop() as CSValue);
      case "DISCARD": this.V.pop(); return;
      case "RET": this.retval = this.V.pop() as CSValue; this.completion = "return"; return;
      case "FUNCRET":
        if (this.completion === "return") { this.completion = "normal"; this.V.push(this.retval); this.retval = null; }
        else this.V.push(null);
        return;

      // ===== expressions =====
      case "EE": return this.evalStep(fr.node as A.Expr, fr.env as SyncEnv);
      case "BIN": {
        const b = this.V.pop() as CSValue;
        const a = this.V.pop() as CSValue;
        this.V.push(this.applyBinary(fr.op as string, a, b, fr.line as number));
        return;
      }
      case "UN": {
        const a = this.V.pop() as CSValue;
        this.V.push(fr.op === "!" ? !truthy(a) : -this.num(a, fr.line as number));
        return;
      }
      case "LOGIC": {
        const a = this.V.pop() as CSValue;
        if (fr.op === "&&") {
          if (!truthy(a)) { this.V.push(false); return; }
        } else {
          if (truthy(a)) { this.V.push(true); return; }
        }
        this.push({ t: "TOBOOL" });
        this.push({ t: "EE", node: fr.rightN, env: fr.env });
        return;
      }
      case "TOBOOL": this.V.push(truthy(this.V.pop() as CSValue)); return;
      case "TERN": {
        const c = this.V.pop();
        this.push({ t: "EE", node: truthy(c as CSValue) ? fr.thenN : (fr.elseN as A.Expr), env: fr.env });
        return;
      }
      case "MEMBER": this.V.push(this.getProp(this.V.pop() as CSValue, fr.prop as string, fr.line as number)); return;
      case "INDEX": {
        const idx = this.V.pop() as CSValue;
        const obj = this.V.pop() as CSValue;
        this.V.push(this.getIndex(obj, idx, fr.line as number));
        return;
      }
      case "MKLIST": this.V.push(this.V.splice(this.V.length - (fr.n as number), fr.n as number)); return;
      case "MKRANGE": {
        const hi = this.num(this.V.pop() as CSValue, fr.line as number);
        const lo = this.num(this.V.pop() as CSValue, fr.line as number);
        const out: CSValue[] = [];
        for (let i = lo; i <= hi; i++) out.push(i);
        this.V.push(out);
        return;
      }
      case "MKRECORD": {
        const keys = fr.keys as string[];
        const vals = this.V.splice(this.V.length - keys.length, keys.length);
        const rec = new CSRecord();
        keys.forEach((k, i) => rec.set(k, vals[i]));
        this.V.push(rec);
        return;
      }
      case "CHOOSE": {
        const n = fr.n as number;
        const vals = this.V.splice(this.V.length - n, n);
        const player = vals[0];
        const options = vals[1];
        const prompt = n > 2 ? String(vals[2]) : "";
        if (!(player instanceof Player)) throw new RuntimeError("choose: arg 1 must be a player");
        if (!Array.isArray(options)) throw new RuntimeError("choose: arg 2 must be a list");
        this.pending = { player, options, prompt };
        return;
      }
      case "CALLN": {
        const args = this.V.splice(this.V.length - (fr.n as number), fr.n as number);
        const callee = this.V.pop() as CSValue;
        if (callee && (callee as Record<string, unknown>).userFn) this.applyUser(callee as Callable & Record<string, unknown>, args);
        else this.V.push(this.callValue(callee, args));
        return;
      }
      default:
        throw new RuntimeError(`vm: unknown frame ${fr.t}`);
    }
  }

  private applyUser(closure: Callable & Record<string, unknown>, args: CSValue[]): void {
    const env = new SyncEnv(closure.cenv as SyncEnv);
    (closure.params as string[]).forEach((p, i) => env.define(p, args[i] ?? null));
    if (closure.kind === "expr") {
      this.push({ t: "EE", node: closure.body as A.Expr, env });
    } else {
      this.push({ t: "FUNCRET" });
      this.push({ t: "ES", node: closure.body as A.Block, env });
    }
  }

  // execute a statement, decomposing only if it can choose
  private execStep(node: A.Stmt, env: SyncEnv): void {
    if (!this.mayChoose(node)) {
      try {
        this.execStmt(node, env);
      } catch (e) {
        if (e instanceof BreakSignal) this.completion = "break";
        else if (e instanceof ContinueSignal) this.completion = "continue";
        else if (e instanceof ReturnSignal) { this.completion = "return"; this.retval = e.value; }
        else throw e; // GameOver and real errors propagate
      }
      return;
    }
    switch (node.type) {
      case "Block": this.push({ t: "SEQ", stmts: node.stmts, env: new SyncEnv(env), idx: 0 }); return;
      case "VarStmt":
        this.push({ t: "VARDEF", name: node.name, env });
        this.push({ t: "EE", node: node.init, env });
        return;
      case "AssignStmt":
        this.push({ t: "ASSIGN", target: node.target, env });
        this.push({ t: "EE", node: node.value, env });
        return;
      case "ExprStmt":
        this.push({ t: "DISCARD" });
        this.push({ t: "EE", node: node.expr, env });
        return;
      case "IfStmt":
        this.push({ t: "IFB", thenN: node.then, elseN: node.otherwise, env });
        this.push({ t: "EE", node: node.cond, env });
        return;
      case "WhileStmt": this.push({ t: "WHILE", node, env }); return;
      case "LoopStmt": this.push({ t: "LOOP", node, env }); return;
      case "ForStmt":
        this.push({ t: "FORSTART", node, env });
        this.push({ t: "EE", node: node.iter, env });
        return;
      case "RepeatStmt":
        this.push({ t: "REPSTART", node, env, line: node.line });
        this.push({ t: "EE", node: node.count, env });
        return;
      case "ReturnStmt":
        if (node.expr) { this.push({ t: "RET" }); this.push({ t: "EE", node: node.expr, env }); }
        else { this.retval = null; this.completion = "return"; }
        return;
      default:
        // break/continue can't choose; handled by the sync path above
        this.execStmt(node, env);
    }
  }

  // evaluate an expression, decomposing only if it can choose
  private evalStep(node: A.Expr, env: SyncEnv): void {
    if (!this.mayChoose(node)) {
      this.V.push(this.evalExpr(node, env));
      return;
    }
    switch (node.type) {
      case "Binary":
        this.push({ t: "BIN", op: node.op, line: node.line });
        this.push({ t: "EE", node: node.right, env });
        this.push({ t: "EE", node: node.left, env });
        return;
      case "Logical":
        this.push({ t: "LOGIC", op: node.op, rightN: node.right, env });
        this.push({ t: "EE", node: node.left, env });
        return;
      case "Unary":
        this.push({ t: "UN", op: node.op, line: node.line });
        this.push({ t: "EE", node: node.operand, env });
        return;
      case "Ternary":
        this.push({ t: "TERN", thenN: node.then, elseN: node.otherwise, env });
        this.push({ t: "EE", node: node.cond, env });
        return;
      case "Member":
        this.push({ t: "MEMBER", prop: node.prop, line: node.line });
        this.push({ t: "EE", node: node.obj, env });
        return;
      case "Index":
        this.push({ t: "INDEX", line: node.line });
        this.push({ t: "EE", node: node.index, env });
        this.push({ t: "EE", node: node.obj, env });
        return;
      case "ListLit":
        this.push({ t: "MKLIST", n: node.elements.length });
        for (let i = node.elements.length - 1; i >= 0; i--) this.push({ t: "EE", node: node.elements[i], env });
        return;
      case "RangeExpr":
        this.push({ t: "MKRANGE", line: node.line });
        this.push({ t: "EE", node: node.hi, env });
        this.push({ t: "EE", node: node.lo, env });
        return;
      case "RecordLit":
        this.push({ t: "MKRECORD", keys: node.entries.map((e) => e.key) });
        for (let i = node.entries.length - 1; i >= 0; i--) this.push({ t: "EE", node: node.entries[i].value, env });
        return;
      case "Call": {
        if (node.callee.type === "Identifier" && node.callee.name === "choose") {
          this.push({ t: "CHOOSE", n: node.args.length });
          for (let i = node.args.length - 1; i >= 0; i--) this.push({ t: "EE", node: node.args[i], env });
        } else {
          this.push({ t: "CALLN", n: node.args.length, line: node.line });
          for (let i = node.args.length - 1; i >= 0; i--) this.push({ t: "EE", node: node.args[i], env });
          this.push({ t: "EE", node: node.callee, env });
        }
        return;
      }
      default:
        this.V.push(this.evalExpr(node, env));
    }
  }

  private doAssign(target: A.Expr, env: SyncEnv, value: CSValue): void {
    if (target.type === "Identifier") {
      if (!env.assign(target.name, value)) throw new RuntimeError(`assignment to undeclared variable '${target.name}'`, target.line);
      return;
    }
    if (target.type === "Member") {
      const obj = this.evalExpr(target.obj, env);
      if (obj instanceof Card && target.prop === "value") { obj.value = this.num(value, target.line); return; }
      if (obj instanceof Player && target.prop === "name") { obj.name = String(value); return; }
      throw new RuntimeError(`cannot assign to ${target.prop}`, target.line);
    }
    if (target.type === "Index") {
      const obj = this.evalExpr(target.obj, env);
      const idx = this.evalExpr(target.index, env);
      if (Array.isArray(obj) && typeof idx === "number") { obj[idx] = value; return; }
      throw new RuntimeError("invalid index assignment", target.line);
    }
  }

  // ---- may-choose analysis ----
  private computeChooses(): void {
    const decls = new Map<string, A.Block | A.Expr>();
    for (const s of this.program.sections) {
      if (s.type === "FunctionDecl") decls.set(s.name, s.body);
      else if (s.type === "ScoreDecl") decls.set("score", s.expr);
    }
    for (const name of decls.keys()) this.funcChooses.set(name, false);
    let changed = true;
    while (changed) {
      changed = false;
      this.mcCache = new Map();
      for (const [name, body] of decls) {
        if (!this.funcChooses.get(name) && this.mayChoose(body)) {
          this.funcChooses.set(name, true);
          changed = true;
        }
      }
    }
    this.mcCache = new Map();
  }

  private mayChoose(node: A.Stmt | A.Expr): boolean {
    const cached = this.mcCache.get(node);
    if (cached !== undefined) return cached;
    const r = this.computeMayChoose(node);
    this.mcCache.set(node, r);
    return r;
  }
  private computeMayChoose(node: A.Stmt | A.Expr): boolean {
    const mc = (n: A.Stmt | A.Expr | null): boolean => (n ? this.mayChoose(n) : false);
    switch (node.type) {
      case "Call":
        if (node.callee.type === "Identifier") {
          if (node.callee.name === "choose") return true;
          if (this.funcChooses.get(node.callee.name)) return true;
        }
        return mc(node.callee) || node.args.some((a) => mc(a));
      case "Binary": return mc(node.left) || mc(node.right);
      case "Logical": return mc(node.left) || mc(node.right);
      case "Unary": return mc(node.operand);
      case "Ternary": return mc(node.cond) || mc(node.then) || mc(node.otherwise);
      case "Member": return mc(node.obj);
      case "Index": return mc(node.obj) || mc(node.index);
      case "ListLit": return node.elements.some((e) => mc(e));
      case "RecordLit": return node.entries.some((e) => mc(e.value));
      case "RangeExpr": return mc(node.lo) || mc(node.hi);
      case "Lambda": return false; // lambdas never choose (run synchronously in builtins)
      case "Block": return node.stmts.some((s) => mc(s));
      case "VarStmt": return mc(node.init);
      case "AssignStmt": return mc(node.value) || mc(node.target);
      case "ExprStmt": return mc(node.expr);
      case "IfStmt": return mc(node.cond) || mc(node.then) || mc(node.otherwise);
      case "WhileStmt": return mc(node.cond) || mc(node.body);
      case "ForStmt": return mc(node.iter) || mc(node.body);
      case "LoopStmt": return mc(node.body);
      case "RepeatStmt": return mc(node.count) || mc(node.body);
      case "ReturnStmt": return node.expr ? mc(node.expr) : false;
      default: return false;
    }
  }

  // ---- cloning ----
  clone(): Machine {
    const cg = this.state.clone();
    const pmap = new Map(cg.players.map((p) => [p.id, p]));
    const m = new Machine(this.program, cg, this.decide, { skipZones: true });
    const envMap = new Map<SyncEnv, SyncEnv>();
    const cv = (v: CSValue): CSValue => this.cloneVal(v, pmap, cg, m, envMap);
    // copy game-level `var` bindings (defined during start(), not installGlobals)
    for (const s of this.program.sections) {
      if (s.type === "VarDecl" && this.global.vars.has(s.name)) {
        m.global.define(s.name, cv(this.global.vars.get(s.name) as CSValue));
      }
    }
    m.K = this.K.map((fr) => this.cloneFrame(fr, cv));
    m.V = this.V.map(cv);
    m.completion = this.completion;
    m.retval = cv(this.retval);
    m.finished = this.finished;
    m.winners = this.winners.map((p) => pmap.get(p.id) ?? p);
    m.pending = this.pending
      ? { player: pmap.get(this.pending.player.id) ?? this.pending.player, options: this.pending.options.map(cv), prompt: this.pending.prompt }
      : null;
    return m;
  }

  private cloneFrame(fr: Frame, cv: (v: CSValue) => CSValue): Frame {
    const out: Frame = { ...fr };
    if (fr.env) out.env = cv(fr.env as unknown as CSValue) as unknown as SyncEnv;
    if (fr.items) out.items = (cv(fr.items) as CSValue[]);
    return out;
  }

  private cloneVal(v: CSValue, pmap: Map<number, Player>, cg: GameState, m: Machine, envMap: Map<SyncEnv, SyncEnv>): CSValue {
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Card) return v; // shared (immutable identity)
    if (v instanceof Player) return pmap.get(v.id) ?? v;
    if (v instanceof Labeled) return new Labeled(this.cloneVal(v.value, pmap, cg, m, envMap), v.text);
    if (Array.isArray(v)) return v.map((x) => this.cloneVal(x, pmap, cg, m, envMap));
    if (v instanceof CSRecord) {
      const r = new CSRecord();
      for (const [k, val] of v.map) r.set(k, this.cloneVal(val, pmap, cg, m, envMap));
      return r;
    }
    if (isZoneHandle(v)) {
      if (v.zone === "pile") {
        const owner = v.pile.owner ? pmap.get(v.pile.owner.id) : undefined;
        return { zone: "pile", pile: cg.pileOf(v.pile.def.name, owner) as never };
      }
      return cg.zoneHandle(v.def.name) as never;
    }
    if (v instanceof SyncEnv) {
      if (v === this.global) return m.global as unknown as CSValue;
      const seen = envMap.get(v);
      if (seen) return seen as unknown as CSValue;
      const ne = new SyncEnv(null);
      envMap.set(v, ne);
      ne.parent = v.parent ? (this.cloneVal(v.parent as unknown as CSValue, pmap, cg, m, envMap) as unknown as SyncEnv) : null;
      for (const [k, val] of v.vars) ne.define(k, this.cloneVal(val, pmap, cg, m, envMap));
      return ne as unknown as CSValue;
    }
    if (isCallable(v)) {
      const c = v as Callable & Record<string, unknown>;
      if (c.userFn) {
        // re-create the closure against the clone's machine + cloned environment
        const cenv = this.cloneVal(c.cenv as unknown as CSValue, pmap, cg, m, envMap) as unknown as SyncEnv;
        return c.kind === "expr"
          ? m.makeExprFunction(c.name, c.params as string[], c.body as A.Expr, cenv)
          : m.makeFunction(c.name, c.params as string[], c.body as A.Block, cenv);
      }
      return (m.builtins.get(v.name) ?? v) as CSValue; // builtins rebind to clone gs
    }
    return v;
  }
}

// equality matching the `choose` builtin (unwraps Labeled, compares by id)
function sameValue(a: CSValue, b: CSValue): boolean {
  a = unwrap(a);
  b = unwrap(b);
  if (a === b) return true;
  if (a instanceof Card && b instanceof Card) return a.id === b.id;
  if (a instanceof Player && b instanceof Player) return a.id === b.id;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  return false;
}

// Run a whole game on the stepper, answering choices via `decide`. Mirrors
// runToCompletion but exercises the resumable machinery end-to-end.
export function runMachine(program: A.Program, state: GameState, decide: Decide): Player[] {
  const m = new Machine(program, state, decide);
  let r = m.start();
  let guard = 0;
  while (!r.done) {
    if (++guard > 1_000_000) throw new RuntimeError("vm: runaway");
    const ans = decide(r.request as ChoiceRequest);
    m.supply(ans);
    r = m.next();
  }
  return r.winners as Player[];
}
