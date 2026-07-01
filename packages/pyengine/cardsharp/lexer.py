"""Lexer for ♠# — port of packages/core/src/lexer.ts."""

KEYWORDS = {
    "game", "players", "deck", "zone", "var", "function", "setup", "flow",
    "score", "winners", "if", "else", "while", "for", "in", "loop", "repeat",
    "break", "continue", "return", "true", "false", "null", "per", "up", "down",
    "owner",
}

OPS2 = {"==", "!=", "<=", ">=", "&&", "||", "=>", ".."}
OPS1 = set("+-*/%<>!=?:.()[]{},;")

SUIT_GLYPHS = {"♣": 0, "♦": 1, "♥": 2, "♠": 3}


class LexError(Exception):
    def __init__(self, message, line):
        super().__init__(f"Lex error (line {line}): {message}")
        self.line = line


class Token:
    __slots__ = ("type", "value", "line")

    def __init__(self, type, value, line):
        self.type = type
        self.value = value
        self.line = line


def _is_digit(c):
    return "0" <= c <= "9"


def _is_ident_start(c):
    return ("a" <= c <= "z") or ("A" <= c <= "Z") or c == "_"


def _is_ident_part(c):
    return _is_ident_start(c) or _is_digit(c)


def lex(src):
    tokens = []
    i = 0
    line = 1
    n = len(src)

    def peek(k=0):
        j = i + k
        return src[j] if j < n else ""

    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c in (" ", "\t", "\r"):
            i += 1
            continue
        # comments
        if c == "/" and peek(1) == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and peek(1) == "*":
            i += 2
            while i < n and not (src[i] == "*" and peek(1) == "/"):
                if src[i] == "\n":
                    line += 1
                i += 1
            if i >= n:
                raise LexError("unterminated block comment", line)
            i += 2
            continue
        # strings
        if c == '"':
            i += 1
            s = ""
            while i < n and src[i] != '"':
                if src[i] == "\\":
                    e = src[i + 1] if i + 1 < n else ""
                    if e == "n":
                        s += "\n"
                    elif e == "t":
                        s += "\t"
                    elif e == '"':
                        s += '"'
                    elif e == "\\":
                        s += "\\"
                    else:
                        s += e
                    i += 2
                else:
                    if src[i] == "\n":
                        line += 1
                    s += src[i]
                    i += 1
            if i >= n:
                raise LexError("unterminated string", line)
            i += 1
            tokens.append(Token("string", s, line))
            continue
        # numbers
        if _is_digit(c):
            s = ""
            while i < n and _is_digit(src[i]):
                s += src[i]
                i += 1
            if i < n and src[i] == "." and (i + 1 < n and _is_digit(src[i + 1])):
                s += src[i]
                i += 1
                while i < n and _is_digit(src[i]):
                    s += src[i]
                    i += 1
            tokens.append(Token("number", s, line))
            continue
        # identifiers / keywords
        if _is_ident_start(c):
            s = ""
            while i < n and _is_ident_part(src[i]):
                s += src[i]
                i += 1
            tokens.append(Token("keyword" if s in KEYWORDS else "ident", s, line))
            continue
        # unicode suit glyphs -> identifiers bound to suit constants
        if c in SUIT_GLYPHS:
            tokens.append(Token("ident", c, line))
            i += 1
            continue
        # operators
        two = src[i:i + 2]
        if two in OPS2:
            tokens.append(Token("op", two, line))
            i += 2
            continue
        if c in OPS1:
            tokens.append(Token("op", c, line))
            i += 1
            continue
        raise LexError(f"unexpected character '{c}'", line)

    tokens.append(Token("eof", "", line))
    return tokens
