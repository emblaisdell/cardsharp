// A decision point yielded by the interpreter, answered by a controller.

import type { CSValue, Player } from "./values.ts";

// A single, uniform decision: the acting player picks one of `options`. Every
// branch point in a game is one of these — there is no per-call "kind". How an
// option renders is derived from its own runtime value (a Card draws as a card,
// a Player as a name, `null` as "None"/decline, a `Labeled` as its text), so the
// same request shape serves humans, bots, and ML agents alike.
export interface ChoiceRequest {
  player: Player; // who must decide
  prompt: string;
  options: CSValue[]; // legal choices; may include `null` (decline) and Labeled wrappers
}

// Brand so the engine can distinguish a yielded ChoiceRequest from anything
// else a builtin might yield (currently nothing else does).
export function isChoiceRequest(v: unknown): v is ChoiceRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    "player" in v &&
    "options" in v &&
    "prompt" in v
  );
}
