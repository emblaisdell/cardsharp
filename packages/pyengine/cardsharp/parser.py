"""Recursive-descent parser for ♠# — port of packages/core/src/parser.ts.

AST nodes are plain `Node` objects with a `.type` tag plus per-type attributes,
mirroring the TS object-literal AST.
"""

from .lexer import lex

IDENT_KEYWORDS = {"players", "score", "winners"}


class Node:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def __repr__(self):
        return f"Node({self.type})"


class ParseError(Exception):
    def __init__(self, message, line):
        super().__init__(f"Parse error (line {line}): {message}")
        self.line = line


def parse(src):
    return _Parser(lex(src)).parse_program()


class _Parser:
    def __init__(self, toks):
        self.toks = toks
        self.pos = 0

    def peek(self, k=0):
        return self.toks[min(self.pos + k, len(self.toks) - 1)]

    @property
    def line(self):
        return self.peek().line

    def advance(self):
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def check(self, type, value=None):
        t = self.peek()
        return t.type == type and (value is None or t.value == value)

    def check_op(self, v):
        return self.check("op", v)

    def check_kw(self, v):
        return self.check("keyword", v)

    def peek_is(self, k, type, value=None):
        t = self.peek(k)
        return t.type == type and (value is None or t.value == value)

    def match(self, type, value=None):
        if self.check(type, value):
            self.advance()
            return True
        return False

    def match_op(self, v):
        return self.match("op", v)

    def match_kw(self, v):
        return self.match("keyword", v)

    def expect(self, type, value=None):
        if not self.check(type, value):
            t = self.peek()
            raise ParseError(f"expected {value or type} but found '{t.value or t.type}'", t.line)
        return self.advance()

    def expect_op(self, v):
        return self.expect("op", v)

    def expect_ident(self):
        return self.expect("ident").value

    # ---- program ----
    def parse_program(self):
        line = self.line
        self.expect("keyword", "game")
        name = self.expect("string").value
        self.expect_op("{")
        sections = []
        while not self.check_op("}") and not self.check("eof"):
            sections.append(self.parse_section())
        self.expect_op("}")
        return Node(type="Program", name=name, sections=sections, line=line)

    def parse_section(self):
        line = self.line
        if self.match_kw("players"):
            mn = int(self.expect("number").value)
            mx = mn
            if self.match_op(".."):
                mx = int(self.expect("number").value)
            self.expect_op(";")
            return Node(type="PlayersDecl", min=mn, max=mx, line=line)
        if self.match_kw("deck"):
            deck = self.expect_ident()
            self.expect_op(";")
            return Node(type="DeckDecl", deck=deck, line=line)
        if self.match_kw("zone"):
            name = self.expect_ident()
            self.expect_op(":")
            kind = self.expect_ident()
            layout = "hand" if kind in ("hand", "fan", "spread") else "pile"
            per_player = False
            if self.match_kw("per"):
                self.expect("ident", "player")
                per_player = True
            visibility = None
            if self.match_kw("up"):
                visibility = "up"
            elif self.match_kw("down"):
                visibility = "down"
            elif self.match_kw("owner"):
                visibility = "owner"
            self.expect_op(";")
            if visibility is None:
                visibility = "owner" if per_player else "down"
            return Node(type="ZoneDecl", name=name, perPlayer=per_player,
                        visibility=visibility, layout=layout, line=line)
        if self.match_kw("var"):
            name = self.expect_ident()
            self.expect_op("=")
            init = self.parse_expression()
            self.expect_op(";")
            return Node(type="VarDecl", name=name, init=init, line=line)
        if self.match_kw("function"):
            name = self.expect_ident()
            params = self.parse_param_list()
            body = self.parse_block()
            return Node(type="FunctionDecl", name=name, params=params, body=body, line=line)
        if self.match_kw("setup"):
            return Node(type="SetupDecl", body=self.parse_block(), line=line)
        if self.match_kw("flow"):
            return Node(type="FlowDecl", body=self.parse_block(), line=line)
        if self.match_kw("score"):
            param = self.expect_ident()
            self.expect_op("=>")
            expr = self.parse_expression()
            self.expect_op(";")
            return Node(type="ScoreDecl", param=param, expr=expr, line=line)
        if self.match_kw("winners"):
            self.expect_op("=>")
            expr = self.parse_expression()
            self.expect_op(";")
            return Node(type="WinnersDecl", expr=expr, line=line)
        t = self.peek()
        raise ParseError(f"unexpected '{t.value or t.type}' in game body", t.line)

    def parse_param_list(self):
        self.expect_op("(")
        params = []
        if not self.check_op(")"):
            while True:
                params.append(self.expect_ident())
                if not self.match_op(","):
                    break
        self.expect_op(")")
        return params

    # ---- statements ----
    def parse_block(self):
        line = self.line
        self.expect_op("{")
        stmts = []
        while not self.check_op("}") and not self.check("eof"):
            stmts.append(self.parse_statement())
        self.expect_op("}")
        return Node(type="Block", stmts=stmts, line=line)

    def parse_body(self):
        if self.check_op("{"):
            return self.parse_block()
        stmt = self.parse_statement()
        return Node(type="Block", stmts=[stmt], line=stmt.line)

    def parse_statement(self):
        line = self.line
        if self.check_op("{"):
            return self.parse_block()
        if self.match_kw("var"):
            name = self.expect_ident()
            self.expect_op("=")
            init = self.parse_expression()
            self.expect_op(";")
            return Node(type="VarStmt", name=name, init=init, line=line)
        if self.match_kw("if"):
            self.expect_op("(")
            cond = self.parse_expression()
            self.expect_op(")")
            then = self.parse_body()
            otherwise = None
            if self.match_kw("else"):
                otherwise = self.parse_statement() if self.check_kw("if") else self.parse_body()
            return Node(type="IfStmt", cond=cond, then=then, otherwise=otherwise, line=line)
        if self.match_kw("while"):
            self.expect_op("(")
            cond = self.parse_expression()
            self.expect_op(")")
            return Node(type="WhileStmt", cond=cond, body=self.parse_body(), line=line)
        if self.match_kw("for"):
            self.expect_op("(")
            name = self.expect_ident()
            self.expect("keyword", "in")
            it = self.parse_expression()
            self.expect_op(")")
            return Node(type="ForStmt", name=name, iter=it, body=self.parse_body(), line=line)
        if self.match_kw("loop"):
            return Node(type="LoopStmt", body=self.parse_body(), line=line)
        if self.match_kw("repeat"):
            self.expect_op("(")
            count = self.parse_expression()
            self.expect_op(")")
            return Node(type="RepeatStmt", count=count, body=self.parse_body(), line=line)
        if self.match_kw("break"):
            self.expect_op(";")
            return Node(type="BreakStmt", line=line)
        if self.match_kw("continue"):
            self.expect_op(";")
            return Node(type="ContinueStmt", line=line)
        if self.match_kw("return"):
            expr = None
            if not self.check_op(";"):
                expr = self.parse_expression()
            self.expect_op(";")
            return Node(type="ReturnStmt", expr=expr, line=line)
        expr = self.parse_expression()
        if self.match_op("="):
            value = self.parse_expression()
            self.expect_op(";")
            if expr.type not in ("Identifier", "Member", "Index"):
                raise ParseError("invalid assignment target", line)
            return Node(type="AssignStmt", target=expr, value=value, line=line)
        self.expect_op(";")
        return Node(type="ExprStmt", expr=expr, line=line)

    # ---- expressions ----
    def parse_expression(self):
        lam = self.try_lambda()
        if lam:
            return lam
        return self.parse_ternary()

    def try_lambda(self):
        line = self.line
        if self.check("ident") and self.peek_is(1, "op", "=>"):
            name = self.advance().value
            self.expect_op("=>")
            body = self.parse_expression()
            return Node(type="Lambda", params=[name], body=body, line=line)
        if self.check_op("("):
            save = self.pos
            self.advance()
            params = []
            ok = True
            if not self.check_op(")"):
                while True:
                    if not self.check("ident"):
                        ok = False
                        break
                    params.append(self.advance().value)
                    if not self.match_op(","):
                        break
            if ok and self.match_op(")") and self.check_op("=>"):
                self.advance()
                body = self.parse_expression()
                return Node(type="Lambda", params=params, body=body, line=line)
            self.pos = save
        return None

    def parse_ternary(self):
        cond = self.parse_range()
        if self.match_op("?"):
            then = self.parse_expression()
            self.expect_op(":")
            otherwise = self.parse_expression()
            return Node(type="Ternary", cond=cond, then=then, otherwise=otherwise, line=cond.line)
        return cond

    def parse_range(self):
        lo = self.parse_or()
        if self.match_op(".."):
            hi = self.parse_or()
            return Node(type="RangeExpr", lo=lo, hi=hi, line=lo.line)
        return lo

    def parse_or(self):
        left = self.parse_and()
        while self.check_op("||"):
            line = self.advance().line
            right = self.parse_and()
            left = Node(type="Logical", op="||", left=left, right=right, line=line)
        return left

    def parse_and(self):
        left = self.parse_equality()
        while self.check_op("&&"):
            line = self.advance().line
            right = self.parse_equality()
            left = Node(type="Logical", op="&&", left=left, right=right, line=line)
        return left

    def parse_equality(self):
        left = self.parse_relational()
        while self.check_op("==") or self.check_op("!="):
            op = self.advance()
            right = self.parse_relational()
            left = Node(type="Binary", op=op.value, left=left, right=right, line=op.line)
        return left

    def parse_relational(self):
        left = self.parse_additive()
        while self.check_op("<") or self.check_op("<=") or self.check_op(">") or self.check_op(">="):
            op = self.advance()
            right = self.parse_additive()
            left = Node(type="Binary", op=op.value, left=left, right=right, line=op.line)
        return left

    def parse_additive(self):
        left = self.parse_multiplicative()
        while self.check_op("+") or self.check_op("-"):
            op = self.advance()
            right = self.parse_multiplicative()
            left = Node(type="Binary", op=op.value, left=left, right=right, line=op.line)
        return left

    def parse_multiplicative(self):
        left = self.parse_unary()
        while self.check_op("*") or self.check_op("/") or self.check_op("%"):
            op = self.advance()
            right = self.parse_unary()
            left = Node(type="Binary", op=op.value, left=left, right=right, line=op.line)
        return left

    def parse_unary(self):
        if self.check_op("!") or self.check_op("-"):
            op = self.advance()
            operand = self.parse_unary()
            return Node(type="Unary", op=op.value, operand=operand, line=op.line)
        return self.parse_postfix()

    def parse_postfix(self):
        expr = self.parse_primary()
        while True:
            if self.match_op("."):
                prop = self.expect_ident()
                expr = Node(type="Member", obj=expr, prop=prop, line=expr.line)
            elif self.match_op("["):
                index = self.parse_expression()
                self.expect_op("]")
                expr = Node(type="Index", obj=expr, index=index, line=expr.line)
            elif self.check_op("("):
                args = self.parse_args()
                expr = Node(type="Call", callee=expr, args=args, line=expr.line)
            else:
                return expr

    def parse_args(self):
        self.expect_op("(")
        args = []
        if not self.check_op(")"):
            while True:
                args.append(self.parse_expression())
                if not self.match_op(","):
                    break
        self.expect_op(")")
        return args

    def parse_primary(self):
        t = self.peek()
        line = t.line
        if t.type == "number":
            self.advance()
            v = float(t.value)
            if v.is_integer():
                v = int(v)
            return Node(type="NumberLit", value=v, line=line)
        if t.type == "string":
            self.advance()
            return Node(type="StringLit", value=t.value, line=line)
        if self.match_kw("true"):
            return Node(type="BoolLit", value=True, line=line)
        if self.match_kw("false"):
            return Node(type="BoolLit", value=False, line=line)
        if self.match_kw("null"):
            return Node(type="NullLit", line=line)
        if t.type == "ident" or (t.type == "keyword" and t.value in IDENT_KEYWORDS):
            self.advance()
            return Node(type="Identifier", name=t.value, line=line)
        if self.match_op("("):
            e = self.parse_expression()
            self.expect_op(")")
            return e
        if self.match_op("["):
            elements = []
            if not self.check_op("]"):
                while True:
                    elements.append(self.parse_expression())
                    if not self.match_op(","):
                        break
            self.expect_op("]")
            return Node(type="ListLit", elements=elements, line=line)
        if self.match_op("{"):
            entries = []
            if not self.check_op("}"):
                while True:
                    key = self.advance().value if self.check("string") else self.expect_ident()
                    self.expect_op(":")
                    entries.append({"key": key, "value": self.parse_expression()})
                    if not self.match_op(","):
                        break
            self.expect_op("}")
            return Node(type="RecordLit", entries=entries, line=line)
        raise ParseError(f"unexpected '{t.value or t.type}' in expression", line)
