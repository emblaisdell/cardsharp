"""Synchronous ♠# interpreter — a faithful port of the TS SyncInterp
(packages/core/src/vm-sync.ts) with the standard library (builtins.ts) folded in.

Choices are answered by a synchronous `decide(req)` callback (the controller).
This is all that self-play training needs: the policy *is* the decide callback.
"""

import math
from .values import (
    Card, Pile, Player, Labeled, CSRecord, ZoneHandle, Callable, Builtin,
    is_callable, is_list, is_zone_handle, truthy, type_name, display, unwrap,
    same_value, RANK_NAMES, SUIT_NAMES,
)
from .state import GameState


# ---- signals ----
class GameOver(Exception):
    pass


class BreakSignal(Exception):
    pass


class ContinueSignal(Exception):
    pass


class ReturnSignal(Exception):
    def __init__(self, value):
        self.value = value


class RuntimeError_(Exception):
    def __init__(self, message, line=None):
        super().__init__(f"Runtime error{f' (line {line})' if line else ''}: {message}")


class ChoiceRequest:
    __slots__ = ("player", "options", "prompt")

    def __init__(self, player, options, prompt=""):
        self.player = player
        self.options = options
        self.prompt = prompt


_NOT_FOUND = object()


class Env:
    __slots__ = ("vars", "parent")

    def __init__(self, parent=None):
        self.vars = {}
        self.parent = parent

    def define(self, n, v):
        self.vars[n] = v

    def lookup(self, n):
        e = self
        while e is not None:
            if n in e.vars:
                return e.vars[n]
            e = e.parent
        return _NOT_FOUND

    def assign(self, n, v):
        e = self
        while e is not None:
            if n in e.vars:
                e.vars[n] = v
                return True
            e = e.parent
        return False


class Closure(Callable):
    """A user function (block body) or lambda/score (expr body)."""
    __slots__ = ("name", "params", "body", "closure", "interp", "kind")

    def __init__(self, name, params, body, closure, interp, kind):
        self.name = name
        self.params = params
        self.body = body
        self.closure = closure
        self.interp = interp
        self.kind = kind  # "fn" | "expr"

    def invoke(self, args):
        env = Env(self.closure)
        for i, p in enumerate(self.params):
            env.define(p, args[i] if i < len(args) else None)
        if self.kind == "expr":
            return self.interp.eval_expr(self.body, env)
        try:
            self.interp.exec_block(self.body, env)
        except ReturnSignal as e:
            return e.value
        return None


def _num(v, line=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise RuntimeError_(f"expected a number, got {type_name(v)}", line)
    return v


def _js_round(x):
    return math.floor(x + 0.5)


class Interpreter:
    def __init__(self, program, state, decide, skip_zones=False):
        self.program = program
        self.state = state
        self.decide = decide
        self.global_env = Env()
        self.dynamic = {}
        self.winners_expr = None
        self.has_score = False
        self.builtins = self._make_builtins()
        self._install_globals(skip_zones)

    # ================= builtins =================
    def _make_builtins(self):
        state = self.state
        reg = {}

        def df(name, fn):
            reg[name] = Builtin(name, fn)

        def as_pile(v, who):
            if is_zone_handle(v) and v.zone == "pile":
                return v.pile
            if is_zone_handle(v) and v.zone == "family":
                raise RuntimeError_(f"{who}: per-player zone must be indexed, e.g. hand[player]")
            raise RuntimeError_(f"{who}: expected a zone, got {type_name(v)}")

        def as_list(v, who):
            if is_list(v):
                return v
            raise RuntimeError_(f"{who}: expected a list, got {type_name(v)}")

        def as_player(v, who):
            if isinstance(v, Player):
                return v
            raise RuntimeError_(f"{who}: expected a player, got {type_name(v)}")

        def as_card_list(v, who):
            if isinstance(v, Card):
                return [v]
            if is_list(v):
                return [x for x in v if isinstance(x, Card)]
            raise RuntimeError_(f"{who}: expected card(s), got {type_name(v)}")

        def remove_card(card):
            for pile in state.shared_piles.values():
                for i, c in enumerate(pile.cards):
                    if c.id == card.id:
                        del pile.cards[i]
                        return
            for piles in state.per_player_piles.values():
                for pile in piles:
                    for i, c in enumerate(pile.cards):
                        if c.id == card.id:
                            del pile.cards[i]
                            return

        def call_fn(fn, args):
            if not is_callable(fn):
                raise RuntimeError_(f"expected a function, got {type_name(fn)}")
            return self.call_value(fn, args)

        def key_num(fn, item):
            v = call_fn(fn, [item])
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise RuntimeError_(f"key must yield a number, got {type_name(v)}")
            return v

        # ---- deck / setup ----
        def b_loadDeck(args):
            state.build_standard52(as_pile(args[0], "loadDeck"))
            return None
        df("loadDeck", b_loadDeck)

        def b_setValues(args):
            fn = args[0]

            def apply(pile):
                for c in pile.cards:
                    v = call_fn(fn, [c])
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        c.value = v
            for pile in state.shared_piles.values():
                apply(pile)
            for piles in state.per_player_piles.values():
                for p in piles:
                    apply(p)
            return None
        df("setValues", b_setValues)

        # ---- players & turns ----
        def b_others(args):
            p = as_player(args[0], "others")
            n = len(state.players)
            return [state.players[(p.id + k) % n] for k in range(1, n)]
        df("others", b_others)
        df("playerAfter", lambda args: state.next_active_after(as_player(args[0], "playerAfter")))

        def b_endTurn(args):
            state.turn_count += 1
            state.current = state.next_active_after(state.current)
            return None
        df("endTurn", b_endTurn)

        def b_nextPlayer(args):
            state.current = state.next_active_after(state.current)
            return state.current
        df("nextPlayer", b_nextPlayer)

        def b_setCurrent(args):
            state.current = as_player(args[0], "setCurrent")
            return None
        df("setCurrent", b_setCurrent)

        def b_eliminate(args):
            as_player(args[0], "eliminate").eliminated = True
            return None
        df("eliminate", b_eliminate)
        df("isActive", lambda args: not as_player(args[0], "isActive").eliminated)
        df("active", lambda args: state.active_players())
        df("turnIndex", lambda args: state.turn_count)

        def b_declareWinner(args):
            state.declared_winners = [as_player(args[0], "declareWinner")]
            return None
        df("declareWinner", b_declareWinner)

        def b_declareWinners(args):
            state.declared_winners = [x for x in as_list(args[0], "declareWinners")
                                      if isinstance(x, Player)]
            return None
        df("declareWinners", b_declareWinners)

        def b_endGame(args):
            raise GameOver()
        df("endGame", b_endGame)

        # ---- zones & movement ----
        df("size", lambda args: len(as_pile(args[0], "size").cards))
        df("cards", lambda args: list(as_pile(args[0], "cards").cards))
        df("isEmpty", lambda args: len(as_pile(args[0], "isEmpty").cards) == 0)

        def b_top(args):
            pile = as_pile(args[0], "top")
            n = _num(args[1]) if len(args) > 1 else 1
            return pile.cards[:n]
        df("top", b_top)

        def b_bottom(args):
            pile = as_pile(args[0], "bottom")
            n = _num(args[1]) if len(args) > 1 else 1
            return pile.cards[max(0, len(pile.cards) - n):]
        df("bottom", b_bottom)

        def b_shuffle(args):
            state.rng.shuffle(as_pile(args[0], "shuffle").cards)
            return None
        df("shuffle", b_shuffle)

        def b_move(args):
            cards = as_card_list(args[0], "move")
            to = as_pile(args[1], "move")
            for c in cards:
                remove_card(c)
                to.cards.insert(0, c)
            return None
        df("move", b_move)

        def b_moveTo(args):
            cards = as_card_list(args[0], "moveTo")
            to = as_pile(args[1], "moveTo")
            where = str(args[2]) if len(args) > 2 else "top"
            for c in cards:
                remove_card(c)
                if where == "bottom":
                    to.cards.append(c)
                else:
                    to.cards.insert(0, c)
            return None
        df("moveTo", b_moveTo)

        def b_draw(args):
            frm = as_pile(args[0], "draw")
            to = as_pile(args[1], "draw")
            n = _num(args[2]) if len(args) > 2 else 1
            moved = frm.cards[:n]
            del frm.cards[:n]
            to.cards.extend(moved)
            return moved
        df("draw", b_draw)

        def b_deal(args):
            frm = as_pile(args[0], "deal")
            to_handle = args[1]
            n = _num(args[2])
            if is_zone_handle(to_handle) and to_handle.zone == "family":
                for _ in range(n):
                    for pile in to_handle.piles:
                        if not frm.cards:
                            return None
                        pile.cards.append(frm.cards.pop(0))
            else:
                to = as_pile(args[1], "deal")
                for _ in range(n):
                    if not frm.cards:
                        break
                    to.cards.append(frm.cards.pop(0))
            return None
        df("deal", b_deal)

        # ---- collections ----
        df("count", lambda args: len(as_list(args[0], "count")))

        def b_countIf(args):
            return sum(1 for x in as_list(args[0], "countIf") if truthy(call_fn(args[1], [x])))
        df("countIf", b_countIf)
        df("filter", lambda args: [x for x in as_list(args[0], "filter") if truthy(call_fn(args[1], [x]))])
        df("map", lambda args: [call_fn(args[1], [x]) for x in as_list(args[0], "map")])
        df("any", lambda args: any(truthy(call_fn(args[1], [x])) for x in as_list(args[0], "any")))
        df("all", lambda args: all(truthy(call_fn(args[1], [x])) for x in as_list(args[0], "all")))
        df("none", lambda args: not any(truthy(call_fn(args[1], [x])) for x in as_list(args[0], "none")))

        def b_sum(args):
            lst = as_list(args[0], "sum")
            s = 0
            for x in lst:
                s += key_num(args[1], x) if len(args) > 1 and args[1] is not None else _num(x)
            return s
        df("sum", b_sum)

        def extreme(args, who, direction):
            lst = as_list(args[0], who)
            if not lst:
                return None
            best = lst[0]
            best_key = key_num(args[1], best)
            for i in range(1, len(lst)):
                k = key_num(args[1], lst[i])
                if (k > best_key) if direction > 0 else (k < best_key):
                    best = lst[i]
                    best_key = k
            return best
        df("maxBy", lambda args: extreme(args, "maxBy", 1))
        df("minBy", lambda args: extreme(args, "minBy", -1))

        def b_sortBy(args):
            lst = list(as_list(args[0], "sortBy"))
            keys = [key_num(args[1], x) for x in lst]
            order = sorted(range(len(lst)), key=lambda i: keys[i])
            return [lst[i] for i in order]
        df("sortBy", b_sortBy)

        def reduce_minmax(args, direction):
            if len(args) == 1 and is_list(args[0]):
                lst = args[0]
                if not lst:
                    return None
                best = _num(lst[0])
                for x in lst:
                    best = max(best, _num(x)) if direction > 0 else min(best, _num(x))
                return best
            if len(args) >= 2 and is_list(args[0]) and is_callable(args[1]):
                return extreme(args, "max" if direction > 0 else "min", direction)
            nums = [_num(a) for a in args]
            return max(nums) if direction > 0 else min(nums)
        df("max", lambda args: reduce_minmax(args, 1))
        df("min", lambda args: reduce_minmax(args, -1))

        df("reverse", lambda args: list(reversed(as_list(args[0], "reverse"))))
        df("first", lambda args: (lambda l: l[0] if l else None)(as_list(args[0], "first")))
        df("last", lambda args: (lambda l: l[-1] if l else None)(as_list(args[0], "last")))
        df("take", lambda args: as_list(args[0], "take")[:_num(args[1])])
        df("drop", lambda args: as_list(args[0], "drop")[_num(args[1]):])
        df("concat", lambda args: list(as_list(args[0], "concat")) + list(as_list(args[1], "concat")))

        def b_contains(args):
            lst = as_list(args[0], "contains")
            return any(same_value(args[1], y) for y in lst)
        df("contains", b_contains)

        def b_unique(args):
            out = []
            for x in as_list(args[0], "unique"):
                if not any(same_value(x, y) for y in out):
                    out.append(x)
            return out
        df("unique", b_unique)

        def b_range(args):
            lo = _num(args[0])
            hi = _num(args[1])
            return list(range(lo, hi + 1))
        df("range", b_range)

        def b_groupBy(args):
            rec = CSRecord()
            for x in as_list(args[0], "groupBy"):
                k = display(call_fn(args[1], [x]))
                cur = rec.get(k)
                if is_list(cur):
                    cur.append(x)
                else:
                    rec.set(k, [x])
            return rec
        df("groupBy", b_groupBy)

        # ---- card helpers ----
        def uniq_sorted(xs):
            return sorted(set(xs))
        df("ranksOf", lambda args: uniq_sorted([c.rank for c in as_card_list(args[0], "ranksOf")]))
        df("suitsOf", lambda args: uniq_sorted([c.suit for c in as_card_list(args[0], "suitsOf")]))
        df("rankName", lambda args: RANK_NAMES[_num(args[0])] if 0 <= _num(args[0]) < len(RANK_NAMES) else str(_num(args[0])))
        df("suitName", lambda args: SUIT_NAMES[_num(args[0])] if 0 <= _num(args[0]) < 4 else str(_num(args[0])))

        def b_sameRank(args):
            cs = as_card_list(args[0], "sameRank")
            return len(cs) == 0 or all(c.rank == cs[0].rank for c in cs)
        df("sameRank", b_sameRank)

        def b_sameSuit(args):
            cs = as_card_list(args[0], "sameSuit")
            return len(cs) == 0 or all(c.suit == cs[0].suit for c in cs)
        df("sameSuit", b_sameSuit)

        def to_ranks(v):
            if not is_list(v):
                raise RuntimeError_(f"expected a list, got {type_name(v)}")
            out = []
            for x in v:
                if isinstance(x, Card):
                    out.append(x.rank)
                elif isinstance(x, (int, float)) and not isinstance(x, bool):
                    out.append(x)
                else:
                    raise RuntimeError_(f"isRun: expected cards or rank numbers, got {type_name(x)}")
            return out

        def is_run_of_ranks(ranks, wrap):
            if len(ranks) <= 1:
                return True
            srt = sorted(set(ranks))
            if len(srt) != len(ranks):
                return False
            contiguous = all(srt[i] == srt[i - 1] + 1 for i in range(1, len(srt)))
            if contiguous:
                return True
            if not wrap:
                return False
            present = set(srt)
            for start in range(1, 14):
                ok = True
                for i in range(len(srt)):
                    r = ((start - 1 + i) % 13) + 1
                    if r not in present:
                        ok = False
                        break
                if ok:
                    return True
            return False

        def b_isRun(args):
            wrap = truthy(args[1]) if len(args) > 1 else False
            return is_run_of_ranks(to_ranks(args[0]), wrap)
        df("isRun", b_isRun)

        def b_findMelds(args):
            cs = as_card_list(args[0], "findMelds")
            melds = []
            by_rank = {}
            for c in cs:
                by_rank.setdefault(c.rank, []).append(c)
            for g in by_rank.values():
                if len(g) >= 2:
                    melds.append(g)
            for suit in range(4):
                in_suit = [c for c in cs if c.suit == suit]
                present = set(c.rank for c in in_suit)
                first_of = {}
                for c in in_suit:
                    if c.rank not in first_of:
                        first_of[c.rank] = c
                distinct = list(present)
                if len(distinct) == 13:
                    melds.append([first_of[r] for r in range(1, 14)])
                elif len(distinct) >= 2:
                    for r in distinct:
                        pred = 13 if r == 1 else r - 1
                        if pred in present:
                            continue
                        run = []
                        cur = r
                        while cur in present:
                            run.append(first_of[cur])
                            cur = 1 if cur == 13 else cur + 1
                        if len(run) >= 2:
                            melds.append(run)
            return melds
        df("findMelds", b_findMelds)

        def b_valueOf(args):
            if isinstance(args[0], Card):
                return args[0].value
            raise RuntimeError_("valueOf: expected a card")
        df("valueOf", b_valueOf)
        df("handValue", lambda args: sum(c.value for c in as_card_list(args[0], "handValue")))

        def players_extreme(key_fn, direction):
            ps = state.active_players()
            scored = [(p, key_num(key_fn, p)) for p in ps]
            if not scored:
                return []
            best = scored[0][1]
            for _, k in scored:
                best = max(best, k) if direction > 0 else min(best, k)
            return [p for p, k in scored if k == best]
        df("playersWithMax", lambda args: players_extreme(args[0], 1))
        df("playersWithMin", lambda args: players_extreme(args[0], -1))

        # ---- decisions ----
        def b_choose(args):
            who = as_player(args[0], "choose")
            options = as_list(args[1], "choose")
            prompt = str(args[2]) if len(args) > 2 else ""
            req = ChoiceRequest(who, options, prompt)
            answer = self.decide(req)
            if not any(same_value(o, answer) for o in options):
                raise RuntimeError_(f"controller chose an illegal option: {display(answer)}")
            return unwrap(answer)
        df("choose", b_choose)
        df("labeled", lambda args: Labeled(args[0], str(args[1])))

        # ---- misc ----
        def b_log(args):
            if state.globals.get("__quiet") is not True:
                print("[game]", *[display(a) for a in args])
            return None
        df("log", b_log)

        def b_announce(args):
            msg = " ".join(display(a) for a in args)
            if state.on_announce:
                state.on_announce(msg)
            elif state.globals.get("__quiet") is not True:
                print("»", msg)
            return None
        df("announce", b_announce)
        df("rng", lambda args: state.rng.next())
        df("abs", lambda args: abs(_num(args[0])))
        df("floor", lambda args: math.floor(_num(args[0])))
        df("ceil", lambda args: math.ceil(_num(args[0])))
        df("round", lambda args: _js_round(_num(args[0])))

        return reg

    # ================= globals =================
    def _install_globals(self, skip_zones):
        for name, fn in self.builtins.items():
            self.global_env.define(name, fn)
        consts = {
            "Ace": 1, "Jack": 11, "Queen": 12, "King": 13,
            "Clubs": 0, "Diamonds": 1, "Hearts": 2, "Spades": 3,
            "♣": 0, "♦": 1, "♥": 2, "♠": 3,
            "ranks": list(range(1, 14)),
            "suits": [0, 1, 2, 3],
        }
        for k, v in consts.items():
            self.global_env.define(k, v)
        self.dynamic["current"] = lambda: self.state.current
        self.dynamic["players"] = lambda: list(self.state.players)
        self.dynamic["activePlayers"] = lambda: self.state.active_players()

        if not skip_zones:
            for s in self.program.sections:
                if s.type == "ZoneDecl":
                    self.state.define_zone(ZoneDef_from(s))
        for name in self.state.zone_defs:
            self.global_env.define(name, self.state.zone_handle(name))
        for s in self.program.sections:
            if s.type == "FunctionDecl":
                self.global_env.define(s.name, Closure(s.name, s.params, s.body, self.global_env, self, "fn"))
            elif s.type == "ScoreDecl":
                self.global_env.define("score", Closure("score", [s.param], s.expr, self.global_env, self, "expr"))
                self.has_score = True
            elif s.type == "WinnersDecl":
                self.winners_expr = s.expr

    # ================= run =================
    def run(self):
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
        if flow:
            try:
                self.exec_block(flow.body, Env(self.global_env))
            except GameOver:
                pass
        self.state.ended = True
        if self.state.declared_winners is None and self.winners_expr is not None:
            self.state.declared_winners = self._to_players(self.eval_expr(self.winners_expr, Env(self.global_env)))
        elif self.state.declared_winners is None and self.has_score:
            self.state.declared_winners = self._winners_by_score()
        for s in self.program.sections:
            if s.type == "VarDecl":
                v = self.global_env.lookup(s.name)
                if v is not _NOT_FOUND:
                    self.state.globals[s.name] = v
        return self.state.declared_winners or []

    def score_of(self, p):
        return self._call_score(p)

    def _winners_by_score(self):
        ps = self.state.players
        if not ps:
            return []
        sc = [self._call_score(p) for p in ps]
        best = max(sc)
        return [ps[i] for i in range(len(ps)) if sc[i] == best]

    def _call_score(self, p):
        fn = self.global_env.lookup("score")
        if fn is _NOT_FOUND or not is_callable(fn):
            return 0
        v = self.call_value(fn, [p])
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

    def _to_players(self, v):
        if isinstance(v, Player):
            return [v]
        if is_list(v):
            return [x for x in v if isinstance(x, Player)]
        return []

    # ================= callables =================
    def call_value(self, fn, args):
        if not is_callable(fn):
            raise RuntimeError_(f"'{display(fn)}' is not callable")
        return fn.invoke(args)

    # ================= statements =================
    def exec_block(self, block, env):
        scope = Env(env)
        for st in block.stmts:
            self.exec_stmt(st, scope)

    def exec_stmt(self, stmt, env):
        t = stmt.type
        if t == "Block":
            self.exec_block(stmt, env)
        elif t == "VarStmt":
            env.define(stmt.name, self.eval_expr(stmt.init, env))
        elif t == "AssignStmt":
            self.exec_assign(stmt, env)
        elif t == "ExprStmt":
            self.eval_expr(stmt.expr, env)
        elif t == "IfStmt":
            if truthy(self.eval_expr(stmt.cond, env)):
                self.exec_block(stmt.then, env)
            elif stmt.otherwise is not None:
                if stmt.otherwise.type == "IfStmt":
                    self.exec_stmt(stmt.otherwise, env)
                else:
                    self.exec_block(stmt.otherwise, env)
        elif t == "WhileStmt":
            while truthy(self.eval_expr(stmt.cond, env)):
                try:
                    self.exec_block(stmt.body, env)
                except BreakSignal:
                    break
                except ContinueSignal:
                    continue
        elif t == "LoopStmt":
            while True:
                try:
                    self.exec_block(stmt.body, env)
                except BreakSignal:
                    break
                except ContinueSignal:
                    continue
        elif t == "RepeatStmt":
            n = _num(self.eval_expr(stmt.count, env), stmt.line)
            for _ in range(n):
                try:
                    self.exec_block(stmt.body, env)
                except BreakSignal:
                    break
                except ContinueSignal:
                    continue
        elif t == "ForStmt":
            it = self.eval_expr(stmt.iter, env)
            if not is_list(it):
                raise RuntimeError_(f"for-in expects a list, got {type_name(it)}", stmt.line)
            for item in list(it):
                scope = Env(env)
                scope.define(stmt.name, item)
                try:
                    self.exec_block(stmt.body, scope)
                except BreakSignal:
                    break
                except ContinueSignal:
                    continue
        elif t == "BreakStmt":
            raise BreakSignal()
        elif t == "ContinueStmt":
            raise ContinueSignal()
        elif t == "ReturnStmt":
            raise ReturnSignal(self.eval_expr(stmt.expr, env) if stmt.expr is not None else None)
        else:
            raise RuntimeError_(f"unknown statement {t}", stmt.line)

    def exec_assign(self, stmt, env):
        value = self.eval_expr(stmt.value, env)
        t = stmt.target
        if t.type == "Identifier":
            if not env.assign(t.name, value):
                raise RuntimeError_(f"assignment to undeclared variable '{t.name}'", stmt.line)
            return
        if t.type == "Member":
            obj = self.eval_expr(t.obj, env)
            if isinstance(obj, Card) and t.prop == "value":
                obj.value = _num(value, stmt.line)
                return
            if isinstance(obj, Player) and t.prop == "name":
                obj.name = str(value)
                return
            raise RuntimeError_(f"cannot assign to {type_name(obj)}.{t.prop}", stmt.line)
        if t.type == "Index":
            obj = self.eval_expr(t.obj, env)
            idx = self.eval_expr(t.index, env)
            if is_list(obj) and isinstance(idx, (int, float)) and not isinstance(idx, bool):
                obj[int(idx)] = value
                return
            raise RuntimeError_("invalid index assignment", stmt.line)

    # ================= expressions =================
    def eval_expr(self, expr, env):
        t = expr.type
        if t == "NumberLit":
            return expr.value
        if t == "StringLit":
            return expr.value
        if t == "BoolLit":
            return expr.value
        if t == "NullLit":
            return None
        if t == "ListLit":
            return [self.eval_expr(el, env) for el in expr.elements]
        if t == "RecordLit":
            rec = CSRecord()
            for e in expr.entries:
                rec.set(e["key"], self.eval_expr(e["value"], env))
            return rec
        if t == "Identifier":
            v = env.lookup(expr.name)
            if v is not _NOT_FOUND:
                return v
            dyn = self.dynamic.get(expr.name)
            if dyn:
                return dyn()
            raise RuntimeError_(f"undefined name '{expr.name}'", expr.line)
        if t == "Lambda":
            return Closure("lambda", expr.params, expr.body, env, self, "expr")
        if t == "RangeExpr":
            lo = _num(self.eval_expr(expr.lo, env), expr.line)
            hi = _num(self.eval_expr(expr.hi, env), expr.line)
            return list(range(lo, hi + 1))
        if t == "Unary":
            v = self.eval_expr(expr.operand, env)
            return (not truthy(v)) if expr.op == "!" else -_num(v, expr.line)
        if t == "Logical":
            l = self.eval_expr(expr.left, env)
            if expr.op == "&&":
                return truthy(self.eval_expr(expr.right, env)) if truthy(l) else False
            return True if truthy(l) else truthy(self.eval_expr(expr.right, env))
        if t == "Binary":
            return self.apply_binary(expr.op, self.eval_expr(expr.left, env),
                                     self.eval_expr(expr.right, env), expr.line)
        if t == "Ternary":
            return (self.eval_expr(expr.then, env) if truthy(self.eval_expr(expr.cond, env))
                    else self.eval_expr(expr.otherwise, env))
        if t == "Member":
            return self.get_prop(self.eval_expr(expr.obj, env), expr.prop, expr.line)
        if t == "Index":
            return self.get_index(self.eval_expr(expr.obj, env),
                                  self.eval_expr(expr.index, env), expr.line)
        if t == "Call":
            callee = self.eval_expr(expr.callee, env)
            args = [self.eval_expr(a, env) for a in expr.args]
            return self.call_value(callee, args)
        raise RuntimeError_(f"unknown expr {t}", expr.line)

    def apply_binary(self, op, a, b, line):
        if op == "==":
            return self._equals(a, b)
        if op == "!=":
            return not self._equals(a, b)
        if op == "+":
            if isinstance(a, str) or isinstance(b, str):
                return display(a) + display(b)
            return _num(a, line) + _num(b, line)
        if op == "-":
            return _num(a, line) - _num(b, line)
        if op == "*":
            return _num(a, line) * _num(b, line)
        if op == "/":
            return _num(a, line) / _num(b, line)
        if op == "%":
            return math.fmod(_num(a, line), _num(b, line))
        if op in ("<", "<=", ">", ">="):
            return self._compare(a, b, op, line)
        raise RuntimeError_(f"unknown operator {op}", line)

    def _equals(self, a, b):
        if isinstance(a, Card) and isinstance(b, Card):
            return a.id == b.id
        if isinstance(a, Player) and isinstance(b, Player):
            return a.id == b.id
        if isinstance(a, bool) or isinstance(b, bool):
            return a is b
        if a is None or b is None:
            return a is b
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            return a == b
        if isinstance(a, str) and isinstance(b, str):
            return a == b
        return a is b

    def _compare(self, a, b, op, line):
        if isinstance(a, str) and isinstance(b, str):
            x = -1 if a < b else (1 if a > b else 0)
            y = 0
        else:
            x = _num(a, line)
            y = _num(b, line)
        if op == "<":
            return x < y
        if op == "<=":
            return x <= y
        if op == ">":
            return x > y
        if op == ">=":
            return x >= y
        return False

    def get_prop(self, obj, prop, line):
        if isinstance(obj, Card):
            m = {"rank": obj.rank, "suit": obj.suit, "value": obj.value, "id": obj.id,
                 "color": None, "rankName": None, "suitName": None, "glyph": None, "label": None}
            if prop in ("color", "rankName", "suitName", "glyph", "label"):
                return getattr(obj, prop)
            if prop in m:
                return m[prop]
        if isinstance(obj, Player):
            if prop == "id":
                return obj.id
            if prop == "name":
                return obj.name
            if prop in ("out", "eliminated"):
                return obj.eliminated
        if isinstance(obj, CSRecord):
            return obj.get(prop)
        raise RuntimeError_(f"no property '{prop}' on {type_name(obj)}", line)

    def get_index(self, obj, idx, line):
        if is_list(obj):
            if isinstance(idx, bool) or not isinstance(idx, (int, float)):
                raise RuntimeError_("list index must be a number", line)
            i = int(idx)
            return obj[i] if 0 <= i < len(obj) else None
        if is_zone_handle(obj) and obj.zone == "family":
            if isinstance(idx, Player):
                return ZoneHandle("pile", pile=obj.piles[idx.id])
            if isinstance(idx, (int, float)) and not isinstance(idx, bool):
                return ZoneHandle("pile", pile=obj.piles[int(idx)])
            raise RuntimeError_("zone index must be a player", line)
        raise RuntimeError_(f"cannot index {type_name(obj)}", line)


def ZoneDef_from(s):
    from .values import ZoneDef
    return ZoneDef(s.name, s.perPlayer, s.visibility, s.layout)


def run_to_completion(program, state, decide):
    return Interpreter(program, state, decide).run()
