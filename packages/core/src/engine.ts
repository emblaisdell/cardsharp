// High-level driver: parse a Card# program, build state, and run it to
// completion against a set of controllers. This is the loop the CLI, the
// WebRTC peers, and the ML trainer all use.

import { parse } from "./parser.ts";
import { check, TypeCheckError } from "./checker.ts";
import type { Diagnostic } from "./checker.ts";
import type * as A from "./ast.ts";
import { GameState } from "./state.ts";
import type { Observation } from "./state.ts";
import { Interpreter } from "./interpreter.ts";
import type { CSValue, Player } from "./values.ts";
import { display } from "./values.ts";
import type { ChoiceRequest } from "./choice.ts";
import type { Controller } from "./controllers.ts";

export interface RunOptions {
  players?: number; // how many seats (must fit the game's `players` decl)
  seed?: number;
  names?: string[];
  quiet?: boolean; // suppress log() output
  // called at every decision point (for transcripts / ML datasets)
  onChoice?: (req: ChoiceRequest, obs: Observation, answer: CSValue) => void;
  maxSteps?: number; // safety valve against runaway games
}

export interface RunResult {
  winners: Player[];
  state: GameState;
  steps: number;
}

function playersRange(program: A.Program): { min: number; max: number } {
  const decl = program.sections.find((s) => s.type === "PlayersDecl") as
    | A.PlayersDecl
    | undefined;
  if (!decl) return { min: 2, max: 8 };
  return { min: decl.min, max: decl.max };
}

export interface CompileOptions {
  typecheck?: boolean; // default true — run the static type checker
}

// Parse and (by default) type-check a Card# program. Throws ParseError on a
// syntax error and TypeCheckError if static type checking finds any problems.
export function compile(source: string, opts: CompileOptions = {}): A.Program {
  const program = parse(source);
  if (opts.typecheck !== false) {
    const diags = check(program);
    if (diags.length) throw new TypeCheckError(diags);
  }
  return program;
}

// Type-check without throwing (for editors / the CLI `check` command).
export function typecheck(source: string): Diagnostic[] {
  return check(parse(source));
}

export async function runGame(
  source: string | A.Program,
  controllers: Controller[] | ((seat: number) => Controller),
  opts: RunOptions = {},
): Promise<RunResult> {
  const program = typeof source === "string" ? compile(source) : source;
  const range = playersRange(program);
  const np = opts.players ?? range.min;
  if (np < range.min || np > range.max) {
    throw new Error(
      `game "${program.name}" supports ${range.min}..${range.max} players, got ${np}`,
    );
  }

  const state = new GameState(np, opts.seed ?? 1, opts.names);
  if (opts.quiet) state.globals.set("__quiet", true);

  const getController =
    typeof controllers === "function" ? controllers : (seat: number) => controllers[seat];

  const interp = new Interpreter(program, state);
  const gen = interp.runGame();

  const maxSteps = opts.maxSteps ?? 100000;
  let steps = 0;
  let next = gen.next();
  while (!next.done) {
    const req = next.value as ChoiceRequest;
    if (++steps > maxSteps) {
      throw new Error(`game exceeded ${maxSteps} decision steps (possible infinite loop)`);
    }
    const controller = getController(req.player.id);
    if (!controller) throw new Error(`no controller for seat ${req.player.id}`);
    const obs = state.observe(req.player);
    const answer = await controller.choose(req, obs);
    opts.onChoice?.(req, obs, answer as CSValue);
    next = gen.next(answer as CSValue);
  }

  return { winners: next.value, state, steps };
}

export function winnerNames(result: RunResult): string {
  return result.winners.length ? result.winners.map((p) => p.name).join(", ") : "(none)";
}

export { display };
