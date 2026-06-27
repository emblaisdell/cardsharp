// Abstract syntax tree for ♠#.

export interface Node {
  line: number;
}

// ---- Program / declarations ----------------------------------------------

export interface Program extends Node {
  type: "Program";
  name: string;
  sections: Section[];
}

export type Section =
  | PlayersDecl
  | DeckDecl
  | ZoneDecl
  | VarDecl
  | FunctionDecl
  | SetupDecl
  | FlowDecl
  | ScoreDecl
  | WinnersDecl;

export interface PlayersDecl extends Node {
  type: "PlayersDecl";
  min: number;
  max: number;
}

export interface DeckDecl extends Node {
  type: "DeckDecl";
  deck: string; // "standard52"
}

export interface ZoneDecl extends Node {
  type: "ZoneDecl";
  name: string;
  perPlayer: boolean;
  visibility: "up" | "down" | "owner";
  layout: "pile" | "hand"; // rendering hint: stacked pile vs fully-spread hand
}

export interface VarDecl extends Node {
  type: "VarDecl";
  name: string;
  init: Expr;
}

export interface FunctionDecl extends Node {
  type: "FunctionDecl";
  name: string;
  params: string[];
  body: Block;
}

export interface SetupDecl extends Node {
  type: "SetupDecl";
  body: Block;
}

export interface FlowDecl extends Node {
  type: "FlowDecl";
  body: Block;
}

export interface ScoreDecl extends Node {
  type: "ScoreDecl";
  param: string;
  expr: Expr;
}

export interface WinnersDecl extends Node {
  type: "WinnersDecl";
  expr: Expr;
}

// ---- Statements -----------------------------------------------------------

export type Stmt =
  | Block
  | VarStmt
  | AssignStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | LoopStmt
  | RepeatStmt
  | BreakStmt
  | ContinueStmt
  | ReturnStmt
  | ExprStmt;

export interface Block extends Node {
  type: "Block";
  stmts: Stmt[];
}

export interface VarStmt extends Node {
  type: "VarStmt";
  name: string;
  init: Expr;
}

export interface AssignStmt extends Node {
  type: "AssignStmt";
  target: Expr; // Identifier | Member | Index
  value: Expr;
}

export interface IfStmt extends Node {
  type: "IfStmt";
  cond: Expr;
  then: Block;
  otherwise: Block | IfStmt | null;
}

export interface WhileStmt extends Node {
  type: "WhileStmt";
  cond: Expr;
  body: Block;
}

export interface ForStmt extends Node {
  type: "ForStmt";
  name: string;
  iter: Expr;
  body: Block;
}

export interface LoopStmt extends Node {
  type: "LoopStmt";
  body: Block;
}

export interface RepeatStmt extends Node {
  type: "RepeatStmt";
  count: Expr;
  body: Block;
}

export interface BreakStmt extends Node {
  type: "BreakStmt";
}
export interface ContinueStmt extends Node {
  type: "ContinueStmt";
}
export interface ReturnStmt extends Node {
  type: "ReturnStmt";
  expr: Expr | null;
}
export interface ExprStmt extends Node {
  type: "ExprStmt";
  expr: Expr;
}

// ---- Expressions ----------------------------------------------------------

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | NullLit
  | ListLit
  | RecordLit
  | Identifier
  | Member
  | Index
  | Call
  | Unary
  | Binary
  | Logical
  | Ternary
  | RangeExpr
  | Lambda;

export interface NumberLit extends Node {
  type: "NumberLit";
  value: number;
}
export interface StringLit extends Node {
  type: "StringLit";
  value: string;
}
export interface BoolLit extends Node {
  type: "BoolLit";
  value: boolean;
}
export interface NullLit extends Node {
  type: "NullLit";
}
export interface ListLit extends Node {
  type: "ListLit";
  elements: Expr[];
}
export interface RecordLit extends Node {
  type: "RecordLit";
  entries: { key: string; value: Expr }[];
}
export interface Identifier extends Node {
  type: "Identifier";
  name: string;
}
export interface Member extends Node {
  type: "Member";
  obj: Expr;
  prop: string;
}
export interface Index extends Node {
  type: "Index";
  obj: Expr;
  index: Expr;
}
export interface Call extends Node {
  type: "Call";
  callee: Expr;
  args: Expr[];
}
export interface Unary extends Node {
  type: "Unary";
  op: string;
  operand: Expr;
}
export interface Binary extends Node {
  type: "Binary";
  op: string;
  left: Expr;
  right: Expr;
}
export interface Logical extends Node {
  type: "Logical";
  op: string; // && ||
  left: Expr;
  right: Expr;
}
export interface Ternary extends Node {
  type: "Ternary";
  cond: Expr;
  then: Expr;
  otherwise: Expr;
}
export interface RangeExpr extends Node {
  type: "RangeExpr";
  lo: Expr;
  hi: Expr;
}
export interface Lambda extends Node {
  type: "Lambda";
  params: string[];
  body: Expr;
}
