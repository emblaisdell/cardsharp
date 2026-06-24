// Internal control-flow signals, thrown to unwind the tree-walker. These are
// not exposed to game authors.

import type { CSValue } from "./values.ts";

export class BreakSignal {}
export class ContinueSignal {}
export class ReturnSignal {
  value: CSValue;
  constructor(value: CSValue) {
    this.value = value;
  }
}
// Thrown by endGame() / declareWinner-and-stop to abort the flow block.
export class GameOver {}

export class RuntimeError extends Error {
  line?: number;
  constructor(message: string, line?: number) {
    super(line ? `Runtime error (line ${line}): ${message}` : `Runtime error: ${message}`);
    this.line = line;
  }
}
