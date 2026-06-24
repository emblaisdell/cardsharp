// A decision point yielded by the interpreter, answered by a controller.

import type { CSValue, Player } from "./values.ts";

export type ChoiceKind =
  | "player"
  | "card"
  | "cards"
  | "rank"
  | "suit"
  | "option"
  | "number"
  | "boolean";

export interface ChoiceRequest {
  kind: ChoiceKind;
  player: Player; // who must decide
  prompt: string;
  options: CSValue[]; // legal choices (for `number`: [lo, hi])
  min?: number; // for `cards`
  max?: number; // for `cards`
  allowNone?: boolean; // if set, the player may also pick "none" (returns null)
}

// Brand so the engine can distinguish a yielded ChoiceRequest from anything
// else a builtin might yield (currently nothing else does).
export function isChoiceRequest(v: unknown): v is ChoiceRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    "kind" in v &&
    "player" in v &&
    "options" in v
  );
}
