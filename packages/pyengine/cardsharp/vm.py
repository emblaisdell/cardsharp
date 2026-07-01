"""Resumable, cloneable stepper for ♠# — a Python port of packages/core/src/vm.ts.

It runs a game as an explicit machine that suspends at every `choose` and whose
entire state (control stack K, value stack V, environments, GameState) is
cloneable. Non-choosing subtrees run on the synchronous Interpreter (interp.py);
only the path to a `choose` is decomposed onto the explicit stack. This is what
in-process neural IS-MCTS needs: clone the machine at a decision, determinize the
clone, and search.
"""

from .interp import (
    Interpreter, Env, Closure, ChoiceRequest, _NOT_FOUND,
    GameOver, BreakSignal, ContinueSignal, ReturnSignal, RuntimeError_, _num,
)
from .values import (
    Card, Player, Labeled, CSRecord, ZoneHandle, Builtin,
    is_zone_handle, is_callable, truthy, unwrap, same_value,
)


class StepResult:
    __slots__ = ("done", "request", "winners")

    def __init__(self, done, request=None, winners=None):
        self.done = done
        self.request = request
        self.winners = winners


class Machine(Interpreter):
    def __init__(self, program, state, decide, skip_zones=False):
        super().__init__(program, state, decide, skip_zones)
        self.K = []          # control stack of frames (dicts)
        self.V = []          # value stack
        self.completion = "normal"
        self.retval = None
        self.pending = None  # ChoiceRequest or None
        self.finished = False
        self.winners = []
        self.func_chooses = {}
        self.mc_cache = {}
        self._compute_chooses()

    # ---------- public driving interface ----------
    def start(self):
        for s in self.program.sections:
            if s.type == "VarDecl":
                self.global_env.define(s.name, self.eval_expr(s.init, self.global_env))
        setup = next((s for s in self.program.sections if s.type == "SetupDecl"), None)
        flow = next((s for s in self.program.sections if s.type == "FlowDecl"), None)
        if setup:
            try:
                self.exec_block(setup.body, Env(self.global_env))
            except GameOver:
                pass
        self.K = [{"t": "ES", "node": flow.body, "env": Env(self.global_env)}] if flow else []
        return self.next()

    def next(self):
        if self.finished:
            return StepResult(True, winners=self.winners)
        if self.pending:
            return StepResult(False, request=self.pending)
        try:
            while self.K:
                self.step()
                if self.pending:
                    return StepResult(False, request=self.pending)
        except GameOver:
            pass
        return self._finish()

    def supply(self, answer):
        if not self.pending:
            raise RuntimeError_("supply() with no pending choice")
        opts = self.pending.options
        if not any(same_value(o, answer) for o in opts):
            raise RuntimeError_("controller chose an illegal option")
        self.V.append(unwrap(answer))
        self.pending = None

    @property
    def current_request(self):
        return self.pending

    @property
    def is_done(self):
        return self.finished

    def _finish(self):
        self.state.ended = True
        if self.state.declared_winners is None and self.winners_expr is not None:
            self.state.declared_winners = self._to_players(self.eval_expr(self.winners_expr, Env(self.global_env)))
        elif self.state.declared_winners is None and self.has_score:
            self.state.declared_winners = self._winners_by_score()
        self.winners = self.state.declared_winners or []
        self.finished = True
        return StepResult(True, winners=self.winners)

    # ---------- the step ----------
    def push(self, fr):
        self.K.append(fr)

    def step(self):
        fr = self.K.pop()
        t = fr["t"]
        V = self.V

        if t == "ES":
            return self._exec_step(fr["node"], fr["env"])
        if t == "SEQ":
            if self.completion != "normal":
                return
            if fr["idx"] >= len(fr["stmts"]):
                return
            self.push({"t": "SEQ", "stmts": fr["stmts"], "env": fr["env"], "idx": fr["idx"] + 1})
            self.push({"t": "ES", "node": fr["stmts"][fr["idx"]], "env": fr["env"]})
            return
        if t == "IFB":
            cond = V.pop()
            if truthy(cond):
                self.push({"t": "ES", "node": fr["thenN"], "env": fr["env"]})
            elif fr["elseN"]:
                self.push({"t": "ES", "node": fr["elseN"], "env": fr["env"]})
            return
        if t == "WHILE":
            self.push({"t": "WHILEC", "node": fr["node"], "env": fr["env"]})
            self.push({"t": "EE", "node": fr["node"].cond, "env": fr["env"]})
            return
        if t == "WHILEC":
            if not truthy(V.pop()):
                return
            self.push({"t": "LOOPAFTER", "node": fr["node"], "env": fr["env"], "op": "while"})
            self.push({"t": "ES", "node": fr["node"].body, "env": fr["env"]})
            return
        if t == "LOOP":
            self.push({"t": "LOOPAFTER", "node": fr["node"], "env": fr["env"], "op": "loop"})
            self.push({"t": "ES", "node": fr["node"].body, "env": fr["env"]})
            return
        if t == "LOOPAFTER":
            c = self.completion
            if c == "break":
                self.completion = "normal"
                return
            if c == "return":
                return
            if c == "continue":
                self.completion = "normal"
            if fr["op"] == "while":
                self.push({"t": "WHILE", "node": fr["node"], "env": fr["env"]})
            else:
                self.push({"t": "LOOP", "node": fr["node"], "env": fr["env"]})
            return
        if t == "FORSTART":
            items = V.pop()
            if not isinstance(items, list):
                raise RuntimeError_("for-in expects a list")
            self.push({"t": "FOR", "items": items, "idx": 0, "name": fr["node"].name, "node": fr["node"], "env": fr["env"]})
            return
        if t == "FOR":
            items = fr["items"]
            if fr["idx"] >= len(items):
                return
            scope = Env(fr["env"])
            scope.define(fr["name"], items[fr["idx"]])
            self.push({"t": "FORAFTER", "items": items, "idx": fr["idx"], "name": fr["name"], "node": fr["node"], "env": fr["env"]})
            self.push({"t": "ES", "node": fr["node"].body, "env": scope})
            return
        if t == "FORAFTER":
            c = self.completion
            if c == "break":
                self.completion = "normal"
                return
            if c == "return":
                return
            if c == "continue":
                self.completion = "normal"
            self.push({"t": "FOR", "items": fr["items"], "idx": fr["idx"] + 1, "name": fr["name"], "node": fr["node"], "env": fr["env"]})
            return
        if t == "REPSTART":
            n = _num(V.pop(), fr.get("line"))
            self.push({"t": "REP", "n": n, "idx": 0, "node": fr["node"], "env": fr["env"]})
            return
        if t == "REP":
            if fr["idx"] >= fr["n"]:
                return
            self.push({"t": "REPAFTER", "n": fr["n"], "idx": fr["idx"], "node": fr["node"], "env": fr["env"]})
            self.push({"t": "ES", "node": fr["node"].body, "env": Env(fr["env"])})
            return
        if t == "REPAFTER":
            c = self.completion
            if c == "break":
                self.completion = "normal"
                return
            if c == "return":
                return
            if c == "continue":
                self.completion = "normal"
            self.push({"t": "REP", "n": fr["n"], "idx": fr["idx"] + 1, "node": fr["node"], "env": fr["env"]})
            return
        if t == "VARDEF":
            fr["env"].define(fr["name"], V.pop())
            return
        if t == "ASSIGN":
            return self._do_assign(fr["target"], fr["env"], V.pop())
        if t == "DISCARD":
            V.pop()
            return
        if t == "RET":
            self.retval = V.pop()
            self.completion = "return"
            return
        if t == "FUNCRET":
            if self.completion == "return":
                self.completion = "normal"
                V.append(self.retval)
                self.retval = None
            else:
                V.append(None)
            return

        # ----- expressions -----
        if t == "EE":
            return self._eval_step(fr["node"], fr["env"])
        if t == "BIN":
            b = V.pop()
            a = V.pop()
            V.append(self.apply_binary(fr["op"], a, b, fr.get("line")))
            return
        if t == "UN":
            a = V.pop()
            V.append((not truthy(a)) if fr["op"] == "!" else -_num(a, fr.get("line")))
            return
        if t == "LOGIC":
            a = V.pop()
            if fr["op"] == "&&":
                if not truthy(a):
                    V.append(False)
                    return
            else:
                if truthy(a):
                    V.append(True)
                    return
            self.push({"t": "TOBOOL"})
            self.push({"t": "EE", "node": fr["rightN"], "env": fr["env"]})
            return
        if t == "TOBOOL":
            V.append(truthy(V.pop()))
            return
        if t == "TERN":
            c = V.pop()
            self.push({"t": "EE", "node": fr["thenN"] if truthy(c) else fr["elseN"], "env": fr["env"]})
            return
        if t == "MEMBER":
            V.append(self.get_prop(V.pop(), fr["prop"], fr.get("line")))
            return
        if t == "INDEX":
            idx = V.pop()
            obj = V.pop()
            V.append(self.get_index(obj, idx, fr.get("line")))
            return
        if t == "MKLIST":
            n = fr["n"]
            items = V[len(V) - n:]
            del V[len(V) - n:]
            V.append(items)
            return
        if t == "MKRANGE":
            hi = _num(V.pop(), fr.get("line"))
            lo = _num(V.pop(), fr.get("line"))
            V.append(list(range(lo, hi + 1)))
            return
        if t == "MKRECORD":
            keys = fr["keys"]
            vals = V[len(V) - len(keys):]
            del V[len(V) - len(keys):]
            rec = CSRecord()
            for i, k in enumerate(keys):
                rec.set(k, vals[i])
            V.append(rec)
            return
        if t == "CHOOSE":
            n = fr["n"]
            vals = V[len(V) - n:]
            del V[len(V) - n:]
            player = vals[0]
            options = vals[1]
            prompt = str(vals[2]) if n > 2 else ""
            if not isinstance(player, Player):
                raise RuntimeError_("choose: arg 1 must be a player")
            if not isinstance(options, list):
                raise RuntimeError_("choose: arg 2 must be a list")
            self.pending = ChoiceRequest(player, options, prompt)
            return
        if t == "CALLN":
            n = fr["n"]
            args = V[len(V) - n:]
            del V[len(V) - n:]
            callee = V.pop()
            if isinstance(callee, Closure):
                self._apply_user(callee, args)
            else:
                V.append(self.call_value(callee, args))
            return
        raise RuntimeError_(f"vm: unknown frame {t}")

    def _apply_user(self, closure, args):
        env = Env(closure.closure)
        for i, p in enumerate(closure.params):
            env.define(p, args[i] if i < len(args) else None)
        if closure.kind == "expr":
            self.push({"t": "EE", "node": closure.body, "env": env})
        else:
            self.push({"t": "FUNCRET"})
            self.push({"t": "ES", "node": closure.body, "env": env})

    # execute a statement, decomposing only if it can choose
    def _exec_step(self, node, env):
        if not self.may_choose(node):
            try:
                self.exec_stmt(node, env)
            except BreakSignal:
                self.completion = "break"
            except ContinueSignal:
                self.completion = "continue"
            except ReturnSignal as e:
                self.completion = "return"
                self.retval = e.value
            return
        ty = node.type
        if ty == "Block":
            self.push({"t": "SEQ", "stmts": node.stmts, "env": Env(env), "idx": 0})
        elif ty == "VarStmt":
            self.push({"t": "VARDEF", "name": node.name, "env": env})
            self.push({"t": "EE", "node": node.init, "env": env})
        elif ty == "AssignStmt":
            self.push({"t": "ASSIGN", "target": node.target, "env": env})
            self.push({"t": "EE", "node": node.value, "env": env})
        elif ty == "ExprStmt":
            self.push({"t": "DISCARD"})
            self.push({"t": "EE", "node": node.expr, "env": env})
        elif ty == "IfStmt":
            self.push({"t": "IFB", "thenN": node.then, "elseN": node.otherwise, "env": env})
            self.push({"t": "EE", "node": node.cond, "env": env})
        elif ty == "WhileStmt":
            self.push({"t": "WHILE", "node": node, "env": env})
        elif ty == "LoopStmt":
            self.push({"t": "LOOP", "node": node, "env": env})
        elif ty == "ForStmt":
            self.push({"t": "FORSTART", "node": node, "env": env})
            self.push({"t": "EE", "node": node.iter, "env": env})
        elif ty == "RepeatStmt":
            self.push({"t": "REPSTART", "node": node, "env": env, "line": node.line})
            self.push({"t": "EE", "node": node.count, "env": env})
        elif ty == "ReturnStmt":
            if node.expr is not None:
                self.push({"t": "RET"})
                self.push({"t": "EE", "node": node.expr, "env": env})
            else:
                self.retval = None
                self.completion = "return"
        else:
            self.exec_stmt(node, env)

    # evaluate an expression, decomposing only if it can choose
    def _eval_step(self, node, env):
        if not self.may_choose(node):
            self.V.append(self.eval_expr(node, env))
            return
        ty = node.type
        if ty == "Binary":
            self.push({"t": "BIN", "op": node.op, "line": node.line})
            self.push({"t": "EE", "node": node.right, "env": env})
            self.push({"t": "EE", "node": node.left, "env": env})
        elif ty == "Logical":
            self.push({"t": "LOGIC", "op": node.op, "rightN": node.right, "env": env})
            self.push({"t": "EE", "node": node.left, "env": env})
        elif ty == "Unary":
            self.push({"t": "UN", "op": node.op, "line": node.line})
            self.push({"t": "EE", "node": node.operand, "env": env})
        elif ty == "Ternary":
            self.push({"t": "TERN", "thenN": node.then, "elseN": node.otherwise, "env": env})
            self.push({"t": "EE", "node": node.cond, "env": env})
        elif ty == "Member":
            self.push({"t": "MEMBER", "prop": node.prop, "line": node.line})
            self.push({"t": "EE", "node": node.obj, "env": env})
        elif ty == "Index":
            self.push({"t": "INDEX", "line": node.line})
            self.push({"t": "EE", "node": node.index, "env": env})
            self.push({"t": "EE", "node": node.obj, "env": env})
        elif ty == "ListLit":
            self.push({"t": "MKLIST", "n": len(node.elements)})
            for i in range(len(node.elements) - 1, -1, -1):
                self.push({"t": "EE", "node": node.elements[i], "env": env})
        elif ty == "RangeExpr":
            self.push({"t": "MKRANGE", "line": node.line})
            self.push({"t": "EE", "node": node.hi, "env": env})
            self.push({"t": "EE", "node": node.lo, "env": env})
        elif ty == "RecordLit":
            self.push({"t": "MKRECORD", "keys": [e["key"] for e in node.entries]})
            for i in range(len(node.entries) - 1, -1, -1):
                self.push({"t": "EE", "node": node.entries[i]["value"], "env": env})
        elif ty == "Call":
            if node.callee.type == "Identifier" and node.callee.name == "choose":
                self.push({"t": "CHOOSE", "n": len(node.args)})
                for i in range(len(node.args) - 1, -1, -1):
                    self.push({"t": "EE", "node": node.args[i], "env": env})
            else:
                self.push({"t": "CALLN", "n": len(node.args), "line": node.line})
                for i in range(len(node.args) - 1, -1, -1):
                    self.push({"t": "EE", "node": node.args[i], "env": env})
                self.push({"t": "EE", "node": node.callee, "env": env})
        else:
            self.V.append(self.eval_expr(node, env))

    def _do_assign(self, target, env, value):
        if target.type == "Identifier":
            if not env.assign(target.name, value):
                raise RuntimeError_(f"assignment to undeclared variable '{target.name}'", target.line)
            return
        if target.type == "Member":
            obj = self.eval_expr(target.obj, env)
            if isinstance(obj, Card) and target.prop == "value":
                obj.value = _num(value, target.line)
                return
            if isinstance(obj, Player) and target.prop == "name":
                obj.name = str(value)
                return
            raise RuntimeError_(f"cannot assign to {target.prop}", target.line)
        if target.type == "Index":
            obj = self.eval_expr(target.obj, env)
            idx = self.eval_expr(target.index, env)
            if isinstance(obj, list) and isinstance(idx, (int, float)) and not isinstance(idx, bool):
                obj[int(idx)] = value
                return
            raise RuntimeError_("invalid index assignment", target.line)

    # ---------- may-choose analysis ----------
    def _compute_chooses(self):
        decls = {}
        for s in self.program.sections:
            if s.type == "FunctionDecl":
                decls[s.name] = s.body
            elif s.type == "ScoreDecl":
                decls["score"] = s.expr
        for name in decls:
            self.func_chooses[name] = False
        changed = True
        while changed:
            changed = False
            self.mc_cache = {}
            for name, body in decls.items():
                if not self.func_chooses[name] and self.may_choose(body):
                    self.func_chooses[name] = True
                    changed = True
        self.mc_cache = {}

    def may_choose(self, node):
        cached = self.mc_cache.get(node)
        if cached is not None:
            return cached
        r = self._compute_may_choose(node)
        self.mc_cache[node] = r
        return r

    def _compute_may_choose(self, node):
        mc = lambda n: (self.may_choose(n) if n is not None else False)
        ty = node.type
        if ty == "Call":
            if node.callee.type == "Identifier":
                if node.callee.name == "choose":
                    return True
                if self.func_chooses.get(node.callee.name):
                    return True
            return mc(node.callee) or any(mc(a) for a in node.args)
        if ty == "Binary":
            return mc(node.left) or mc(node.right)
        if ty == "Logical":
            return mc(node.left) or mc(node.right)
        if ty == "Unary":
            return mc(node.operand)
        if ty == "Ternary":
            return mc(node.cond) or mc(node.then) or mc(node.otherwise)
        if ty == "Member":
            return mc(node.obj)
        if ty == "Index":
            return mc(node.obj) or mc(node.index)
        if ty == "ListLit":
            return any(mc(e) for e in node.elements)
        if ty == "RecordLit":
            return any(mc(e["value"]) for e in node.entries)
        if ty == "RangeExpr":
            return mc(node.lo) or mc(node.hi)
        if ty == "Lambda":
            return False
        if ty == "Block":
            return any(mc(s) for s in node.stmts)
        if ty == "VarStmt":
            return mc(node.init)
        if ty == "AssignStmt":
            return mc(node.value) or mc(node.target)
        if ty == "ExprStmt":
            return mc(node.expr)
        if ty == "IfStmt":
            return mc(node.cond) or mc(node.then) or mc(node.otherwise)
        if ty == "WhileStmt":
            return mc(node.cond) or mc(node.body)
        if ty == "ForStmt":
            return mc(node.iter) or mc(node.body)
        if ty == "LoopStmt":
            return mc(node.body)
        if ty == "RepeatStmt":
            return mc(node.count) or mc(node.body)
        if ty == "ReturnStmt":
            return mc(node.expr) if node.expr is not None else False
        return False

    # ---------- cloning ----------
    def clone(self):
        cg = self.state.clone()
        pmap = {p.id: p for p in cg.players}
        m = Machine(self.program, cg, self.decide, skip_zones=True)
        env_map = {}

        def cv(v):
            return self._clone_val(v, pmap, cg, m, env_map)

        for s in self.program.sections:
            if s.type == "VarDecl" and s.name in self.global_env.vars:
                m.global_env.define(s.name, cv(self.global_env.vars[s.name]))
        m.K = [self._clone_frame(fr, cv) for fr in self.K]
        m.V = [cv(x) for x in self.V]
        m.completion = self.completion
        m.retval = cv(self.retval)
        m.finished = self.finished
        m.winners = [pmap.get(p.id, p) for p in self.winners]
        if self.pending:
            m.pending = ChoiceRequest(
                pmap.get(self.pending.player.id, self.pending.player),
                [cv(o) for o in self.pending.options], self.pending.prompt)
        else:
            m.pending = None
        return m

    def _clone_frame(self, fr, cv):
        out = dict(fr)
        if fr.get("env") is not None:
            out["env"] = cv(fr["env"])
        if fr.get("items") is not None:
            out["items"] = cv(fr["items"])
        return out

    def _clone_val(self, v, pmap, cg, m, env_map):
        if v is None or isinstance(v, (bool, int, float, str)):
            return v
        if isinstance(v, Card):
            return v
        if isinstance(v, Player):
            return pmap.get(v.id, v)
        if isinstance(v, Labeled):
            return Labeled(self._clone_val(v.value, pmap, cg, m, env_map), v.text)
        if isinstance(v, list):
            return [self._clone_val(x, pmap, cg, m, env_map) for x in v]
        if isinstance(v, CSRecord):
            r = CSRecord()
            for k, val in v.map.items():
                r.set(k, self._clone_val(val, pmap, cg, m, env_map))
            return r
        if isinstance(v, ZoneHandle):
            if v.zone == "pile":
                owner = pmap.get(v.pile.owner.id) if v.pile.owner else None
                return ZoneHandle("pile", pile=cg.pile_of(v.pile.zdef.name, owner))
            return cg.zone_handle(v.zdef.name)
        if isinstance(v, Env):
            if v is self.global_env:
                return m.global_env
            seen = env_map.get(id(v))
            if seen is not None:
                return seen
            ne = Env(None)
            env_map[id(v)] = ne
            ne.parent = self._clone_val(v.parent, pmap, cg, m, env_map) if v.parent else None
            for k, val in v.vars.items():
                ne.define(k, self._clone_val(val, pmap, cg, m, env_map))
            return ne
        if isinstance(v, Closure):
            cenv = self._clone_val(v.closure, pmap, cg, m, env_map)
            return Closure(v.name, v.params, v.body, cenv, m, v.kind)
        if isinstance(v, Builtin):
            return m.builtins.get(v.name, v)
        return v


def run_machine(program, state, decide):
    m = Machine(program, state, decide)
    r = m.start()
    guard = 0
    while not r.done:
        guard += 1
        if guard > 1_000_000:
            raise RuntimeError_("vm: runaway")
        ans = decide(r.request)
        m.supply(ans)
        r = m.next()
    return r.winners
