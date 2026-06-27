// Lexer for ♠#.

export type TokenType = "number" | "string" | "ident" | "keyword" | "op" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
}

export class LexError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`Lex error (line ${line}): ${message}`);
    this.line = line;
  }
}

const KEYWORDS = new Set([
  "game", "players", "deck", "zone", "var", "function", "setup", "flow",
  "score", "winners", "if", "else", "while", "for", "in", "loop", "repeat",
  "break", "continue", "return", "true", "false", "null", "per", "up", "down",
  "owner",
]);

// Multi-character operators, longest first.
const OPS3: string[] = [];
const OPS2 = ["==", "!=", "<=", ">=", "&&", "||", "=>", ".."];
const OPS1 = "+-*/%<>!=?:.()[]{},;";

// Unicode suit glyphs usable as suit constants directly in source.
//   ♣ = Clubs(0)  ♦ = Diamonds(1)  ♥ = Hearts(2)  ♠ = Spades(3)
export const SUIT_GLYPHS: Record<string, number> = {
  "♣": 0, // ♣
  "♦": 1, // ♦
  "♥": 2, // ♥
  "♠": 3, // ♠
};

export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const peek = (k = 0) => src[i + k];

  while (i < n) {
    const c = src[i];

    // whitespace
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }

    // comments
    if (c === "/" && peek(1) === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && peek(1) === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && peek(1) === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      if (i >= n) throw new LexError("unterminated block comment", line);
      i += 2;
      continue;
    }

    // strings
    if (c === '"') {
      i++;
      let s = "";
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") {
          const e = src[i + 1];
          if (e === "n") s += "\n";
          else if (e === "t") s += "\t";
          else if (e === '"') s += '"';
          else if (e === "\\") s += "\\";
          else s += e;
          i += 2;
        } else {
          if (src[i] === "\n") line++;
          s += src[i];
          i++;
        }
      }
      if (i >= n) throw new LexError("unterminated string", line);
      i++; // closing quote
      tokens.push({ type: "string", value: s, line });
      continue;
    }

    // numbers
    if (isDigit(c)) {
      let s = "";
      while (i < n && isDigit(src[i])) s += src[i++];
      // decimal part — but not if it's a `..` range operator
      if (src[i] === "." && isDigit(src[i + 1])) {
        s += src[i++];
        while (i < n && isDigit(src[i])) s += src[i++];
      }
      tokens.push({ type: "number", value: s, line });
      continue;
    }

    // identifiers / keywords
    if (isIdentStart(c)) {
      let s = "";
      while (i < n && isIdentPart(src[i])) s += src[i++];
      tokens.push({ type: KEYWORDS.has(s) ? "keyword" : "ident", value: s, line });
      continue;
    }

    // unicode suit glyphs — emitted as identifiers, bound to suit constants
    if (c in SUIT_GLYPHS) {
      tokens.push({ type: "ident", value: c, line });
      i++;
      continue;
    }

    // operators
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) {
      tokens.push({ type: "op", value: three, line });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      tokens.push({ type: "op", value: two, line });
      i += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      tokens.push({ type: "op", value: c, line });
      i++;
      continue;
    }

    throw new LexError(`unexpected character '${c}'`, line);
  }

  tokens.push({ type: "eof", value: "", line });
  return tokens;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
