// Recursive-descent parser for ♠#.

import { lex } from "./lexer.ts";
import type { Token, TokenType } from "./lexer.ts";
import type * as A from "./ast.ts";

export class ParseError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`Parse error (line ${line}): ${message}`);
    this.line = line;
  }
}

export function parse(src: string): A.Program {
  return new Parser(lex(src)).parseProgram();
}

class Parser {
  private toks: Token[];
  private pos = 0;

  constructor(toks: Token[]) {
    this.toks = toks;
  }

  // ---- token helpers ----
  private peek(k = 0): Token {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)];
  }
  private get line(): number {
    return this.peek().line;
  }
  private advance(): Token {
    return this.toks[this.pos++];
  }
  private check(type: TokenType, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private checkOp(v: string): boolean {
    return this.check("op", v);
  }
  private checkKw(v: string): boolean {
    return this.check("keyword", v);
  }
  private peekIs(k: number, type: TokenType, value?: string): boolean {
    const t = this.peek(k);
    return t.type === type && (value === undefined || t.value === value);
  }
  private match(type: TokenType, value?: string): boolean {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }
  private matchOp(v: string): boolean {
    return this.match("op", v);
  }
  private matchKw(v: string): boolean {
    return this.match("keyword", v);
  }
  private expect(type: TokenType, value?: string): Token {
    if (!this.check(type, value)) {
      const t = this.peek();
      throw new ParseError(
        `expected ${value ?? type} but found '${t.value || t.type}'`,
        t.line,
      );
    }
    return this.advance();
  }
  private expectOp(v: string): Token {
    return this.expect("op", v);
  }
  private expectIdent(): string {
    return this.expect("ident").value;
  }

  // ---- program ----
  parseProgram(): A.Program {
    const line = this.line;
    this.expect("keyword", "game");
    const name = this.expect("string").value;
    this.expectOp("{");
    const sections: A.Section[] = [];
    while (!this.checkOp("}") && !this.check("eof")) {
      sections.push(this.parseSection());
    }
    this.expectOp("}");
    return { type: "Program", name, sections, line };
  }

  private parseSection(): A.Section {
    const line = this.line;
    if (this.matchKw("players")) {
      const min = Number(this.expect("number").value);
      let max = min;
      if (this.matchOp("..")) max = Number(this.expect("number").value);
      this.expectOp(";");
      return { type: "PlayersDecl", min, max, line };
    }
    if (this.matchKw("deck")) {
      const deck = this.expectIdent();
      this.expectOp(";");
      return { type: "DeckDecl", deck, line };
    }
    if (this.matchKw("zone")) {
      const name = this.expectIdent();
      this.expectOp(":");
      const kind = this.expectIdent(); // pile/stack (collapsed) | hand/fan/spread (full)
      const layout = kind === "hand" || kind === "fan" || kind === "spread" ? "hand" : "pile";
      let perPlayer = false;
      if (this.matchKw("per")) {
        this.expect("ident", "player");
        perPlayer = true;
      }
      let visibility: "up" | "down" | "owner" | null = null;
      if (this.matchKw("up")) visibility = "up";
      else if (this.matchKw("down")) visibility = "down";
      else if (this.matchKw("owner")) visibility = "owner";
      this.expectOp(";");
      return {
        type: "ZoneDecl",
        name,
        perPlayer,
        visibility: visibility ?? (perPlayer ? "owner" : "down"),
        layout,
        line,
      };
    }
    if (this.matchKw("var")) {
      const name = this.expectIdent();
      this.expectOp("=");
      const init = this.parseExpression();
      this.expectOp(";");
      return { type: "VarDecl", name, init, line };
    }
    if (this.matchKw("function")) {
      const name = this.expectIdent();
      const params = this.parseParamList();
      const body = this.parseBlock();
      return { type: "FunctionDecl", name, params, body, line };
    }
    if (this.matchKw("setup")) {
      return { type: "SetupDecl", body: this.parseBlock(), line };
    }
    if (this.matchKw("flow")) {
      return { type: "FlowDecl", body: this.parseBlock(), line };
    }
    if (this.matchKw("score")) {
      const param = this.expectIdent();
      this.expectOp("=>");
      const expr = this.parseExpression();
      this.expectOp(";");
      return { type: "ScoreDecl", param, expr, line };
    }
    if (this.matchKw("winners")) {
      this.expectOp("=>");
      const expr = this.parseExpression();
      this.expectOp(";");
      return { type: "WinnersDecl", expr, line };
    }
    const t = this.peek();
    throw new ParseError(`unexpected '${t.value || t.type}' in game body`, t.line);
  }

  private parseParamList(): string[] {
    this.expectOp("(");
    const params: string[] = [];
    if (!this.checkOp(")")) {
      do {
        params.push(this.expectIdent());
      } while (this.matchOp(","));
    }
    this.expectOp(")");
    return params;
  }

  // ---- statements ----
  private parseBlock(): A.Block {
    const line = this.line;
    this.expectOp("{");
    const stmts: A.Stmt[] = [];
    while (!this.checkOp("}") && !this.check("eof")) {
      stmts.push(this.parseStatement());
    }
    this.expectOp("}");
    return { type: "Block", stmts, line };
  }

  // A control-flow body: either a `{ ... }` block or a single statement,
  // normalized to a Block.
  private parseBody(): A.Block {
    if (this.checkOp("{")) return this.parseBlock();
    const stmt = this.parseStatement();
    return { type: "Block", stmts: [stmt], line: stmt.line };
  }

  private parseStatement(): A.Stmt {
    const line = this.line;
    if (this.checkOp("{")) return this.parseBlock();

    if (this.matchKw("var")) {
      const name = this.expectIdent();
      this.expectOp("=");
      const init = this.parseExpression();
      this.expectOp(";");
      return { type: "VarStmt", name, init, line };
    }
    if (this.matchKw("if")) {
      this.expectOp("(");
      const cond = this.parseExpression();
      this.expectOp(")");
      const then = this.parseBody();
      let otherwise: A.Block | A.IfStmt | null = null;
      if (this.matchKw("else")) {
        otherwise = this.checkKw("if")
          ? (this.parseStatement() as A.IfStmt)
          : this.parseBody();
      }
      return { type: "IfStmt", cond, then, otherwise, line };
    }
    if (this.matchKw("while")) {
      this.expectOp("(");
      const cond = this.parseExpression();
      this.expectOp(")");
      return { type: "WhileStmt", cond, body: this.parseBody(), line };
    }
    if (this.matchKw("for")) {
      this.expectOp("(");
      const name = this.expectIdent();
      this.expect("keyword", "in");
      const iter = this.parseExpression();
      this.expectOp(")");
      return { type: "ForStmt", name, iter, body: this.parseBody(), line };
    }
    if (this.matchKw("loop")) {
      return { type: "LoopStmt", body: this.parseBody(), line };
    }
    if (this.matchKw("repeat")) {
      this.expectOp("(");
      const count = this.parseExpression();
      this.expectOp(")");
      return { type: "RepeatStmt", count, body: this.parseBody(), line };
    }
    if (this.matchKw("break")) {
      this.expectOp(";");
      return { type: "BreakStmt", line };
    }
    if (this.matchKw("continue")) {
      this.expectOp(";");
      return { type: "ContinueStmt", line };
    }
    if (this.matchKw("return")) {
      let expr: A.Expr | null = null;
      if (!this.checkOp(";")) expr = this.parseExpression();
      this.expectOp(";");
      return { type: "ReturnStmt", expr, line };
    }

    // expression or assignment statement
    const expr = this.parseExpression();
    if (this.matchOp("=")) {
      const value = this.parseExpression();
      this.expectOp(";");
      if (expr.type !== "Identifier" && expr.type !== "Member" && expr.type !== "Index") {
        throw new ParseError("invalid assignment target", line);
      }
      return { type: "AssignStmt", target: expr, value, line };
    }
    this.expectOp(";");
    return { type: "ExprStmt", expr, line };
  }

  // ---- expressions ----
  private parseExpression(): A.Expr {
    const lambda = this.tryLambda();
    if (lambda) return lambda;
    return this.parseTernary();
  }

  private tryLambda(): A.Lambda | null {
    const line = this.line;
    // single-param: IDENT =>
    if (this.check("ident") && this.peekIs(1, "op", "=>")) {
      const name = this.advance().value;
      this.expectOp("=>");
      const body = this.parseExpression();
      return { type: "Lambda", params: [name], body, line };
    }
    // paren list: ( a, b ) =>
    if (this.checkOp("(")) {
      const save = this.pos;
      this.advance(); // (
      const params: string[] = [];
      let ok = true;
      if (!this.checkOp(")")) {
        do {
          if (!this.check("ident")) {
            ok = false;
            break;
          }
          params.push(this.advance().value);
        } while (this.matchOp(","));
      }
      if (ok && this.matchOp(")") && this.checkOp("=>")) {
        this.advance(); // =>
        const body = this.parseExpression();
        return { type: "Lambda", params, body, line };
      }
      this.pos = save; // not a lambda; rewind
    }
    return null;
  }

  private parseTernary(): A.Expr {
    const cond = this.parseRange();
    if (this.matchOp("?")) {
      const then = this.parseExpression();
      this.expectOp(":");
      const otherwise = this.parseExpression();
      return { type: "Ternary", cond, then, otherwise, line: cond.line };
    }
    return cond;
  }

  private parseRange(): A.Expr {
    const lo = this.parseOr();
    if (this.matchOp("..")) {
      const hi = this.parseOr();
      return { type: "RangeExpr", lo, hi, line: lo.line };
    }
    return lo;
  }

  private parseOr(): A.Expr {
    let left = this.parseAnd();
    while (this.checkOp("||")) {
      const line = this.advance().line;
      const right = this.parseAnd();
      left = { type: "Logical", op: "||", left, right, line };
    }
    return left;
  }
  private parseAnd(): A.Expr {
    let left = this.parseEquality();
    while (this.checkOp("&&")) {
      const line = this.advance().line;
      const right = this.parseEquality();
      left = { type: "Logical", op: "&&", left, right, line };
    }
    return left;
  }
  private parseEquality(): A.Expr {
    let left = this.parseRelational();
    while (this.checkOp("==") || this.checkOp("!=")) {
      const op = this.advance();
      const right = this.parseRelational();
      left = { type: "Binary", op: op.value, left, right, line: op.line };
    }
    return left;
  }
  private parseRelational(): A.Expr {
    let left = this.parseAdditive();
    while (this.checkOp("<") || this.checkOp("<=") || this.checkOp(">") || this.checkOp(">=")) {
      const op = this.advance();
      const right = this.parseAdditive();
      left = { type: "Binary", op: op.value, left, right, line: op.line };
    }
    return left;
  }
  private parseAdditive(): A.Expr {
    let left = this.parseMultiplicative();
    while (this.checkOp("+") || this.checkOp("-")) {
      const op = this.advance();
      const right = this.parseMultiplicative();
      left = { type: "Binary", op: op.value, left, right, line: op.line };
    }
    return left;
  }
  private parseMultiplicative(): A.Expr {
    let left = this.parseUnary();
    while (this.checkOp("*") || this.checkOp("/") || this.checkOp("%")) {
      const op = this.advance();
      const right = this.parseUnary();
      left = { type: "Binary", op: op.value, left, right, line: op.line };
    }
    return left;
  }
  private parseUnary(): A.Expr {
    if (this.checkOp("!") || this.checkOp("-")) {
      const op = this.advance();
      const operand = this.parseUnary();
      return { type: "Unary", op: op.value, operand, line: op.line };
    }
    return this.parsePostfix();
  }
  private parsePostfix(): A.Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.matchOp(".")) {
        const prop = this.expectIdent();
        expr = { type: "Member", obj: expr, prop, line: expr.line };
      } else if (this.matchOp("[")) {
        const index = this.parseExpression();
        this.expectOp("]");
        expr = { type: "Index", obj: expr, index, line: expr.line };
      } else if (this.checkOp("(")) {
        const args = this.parseArgs();
        expr = { type: "Call", callee: expr, args, line: expr.line };
      } else {
        return expr;
      }
    }
  }
  private parseArgs(): A.Expr[] {
    this.expectOp("(");
    const args: A.Expr[] = [];
    if (!this.checkOp(")")) {
      do {
        args.push(this.parseExpression());
      } while (this.matchOp(","));
    }
    this.expectOp(")");
    return args;
  }

  private parsePrimary(): A.Expr {
    const t = this.peek();
    const line = t.line;
    if (t.type === "number") {
      this.advance();
      return { type: "NumberLit", value: Number(t.value), line };
    }
    if (t.type === "string") {
      this.advance();
      return { type: "StringLit", value: t.value, line };
    }
    if (this.matchKw("true")) return { type: "BoolLit", value: true, line };
    if (this.matchKw("false")) return { type: "BoolLit", value: false, line };
    if (this.matchKw("null")) return { type: "NullLit", line };

    // keywords usable as identifiers in expressions (e.g. `players`)
    if (t.type === "ident" || (t.type === "keyword" && IDENT_KEYWORDS.has(t.value))) {
      this.advance();
      return { type: "Identifier", name: t.value, line };
    }

    if (this.matchOp("(")) {
      const e = this.parseExpression();
      this.expectOp(")");
      return e;
    }
    if (this.matchOp("[")) {
      const elements: A.Expr[] = [];
      if (!this.checkOp("]")) {
        do {
          elements.push(this.parseExpression());
        } while (this.matchOp(","));
      }
      this.expectOp("]");
      return { type: "ListLit", elements, line };
    }
    if (this.matchOp("{")) {
      const entries: { key: string; value: A.Expr }[] = [];
      if (!this.checkOp("}")) {
        do {
          const key = this.check("string") ? this.advance().value : this.expectIdent();
          this.expectOp(":");
          entries.push({ key, value: this.parseExpression() });
        } while (this.matchOp(","));
      }
      this.expectOp("}");
      return { type: "RecordLit", entries, line };
    }

    throw new ParseError(`unexpected '${t.value || t.type}' in expression`, line);
  }
}

// keywords that double as identifiers when used in expression position
const IDENT_KEYWORDS = new Set(["players", "score", "winners"]);
