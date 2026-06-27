// A general Monte-Carlo Tree Search player for any ♠# game.
//
// How it works (determinized re-simulation / UCT):
//   The ♠# engine is deterministic given (program, seed, answer-sequence).
//   At its decision point the controller has the full ordered history of every
//   answer the engine has received so far (fed in via the driver's onChoice).
//   To search, it replays that history into a *fresh* game to reproduce the
//   current situation exactly, tries a candidate action, and plays the rest out.
//   Running many such playouts and growing a UCT tree over THIS player's future
//   decisions (opponents and chance are sampled) yields an action value.
//
// IMPORTANT — this is *perfect-information* (a.k.a. "cheating") MCTS: the
// re-simulation uses the real game seed, so each playout sees the true shuffle
// and the opponents' real hidden cards. That makes it a strong UPPER-BOUND
// baseline, not a fair imperfect-information player. It's an honest, standard
// reference point for comparing learners — but don't mistake its strength for
// what a hidden-information agent could achieve. (A fair version would
// determinize by resampling unseen cards; that needs state reconstruction the
// black-box engine doesn't expose.)

import { Interpreter, GameState, RNG, Card, Player, unwrap } from "../../core/src/index.ts";
import type {
  Controller,
  CSValue,
  ChoiceRequest,
  Observation,
} from "../../core/src/index.ts";
import type * as A from "../../core/src/ast.ts";

interface Child {
  visits: number;
  value: number; // summed reward
}
interface Node {
  visits: number;
  children: Map<string, Child>;
}

export interface MctsOptions {
  program: A.Program; // compiled game
  seed: number; // the real game's seed (perfect-information determinization)
  players: number;
  history: CSValue[]; // shared answer log, appended to by the driver (onChoice)
  simulations?: number; // playouts per move
  c?: number; // UCT exploration constant
  // Depth-limited search using the game's `score` as a value heuristic. When set,
  // a rollout that runs `rolloutDepth` decisions without ending is cut off and
  // evaluated by `score` instead of playing all the way out. This makes MCTS
  // tractable on long games (Crazy Bridge, Money³) where full rollouts are huge.
  heuristic?: boolean;
  rolloutDepth?: number; // default 40
  // REQUIRED acknowledgement. This controller re-simulates with the real game
  // seed, so it sees the true shuffle and opponents' hidden cards — it is NOT a
  // fair imperfect-information player, only a perfect-information upper bound for
  // benchmarking. A fair (information-set) MCTS needs the resumable engine so it
  // can search a determinization built from the player's observation; until then,
  // this constructor refuses to run without perfectInfo:true so it can never be
  // wired in as a "fair" bot by accident.
  perfectInfo?: boolean;
}

export class MctsController implements Controller {
  private program: A.Program;
  private seed: number;
  private players: number;
  private history: CSValue[];
  private sims: number;
  private c: number;
  private heuristic: boolean;
  private rolloutDepth: number;

  constructor(opts: MctsOptions) {
    if (!opts.perfectInfo) {
      throw new Error(
        "MctsController sees hidden information (it re-simulates with the real " +
          "seed). It is a perfect-information benchmark baseline, not a fair bot. " +
          "Pass perfectInfo:true to acknowledge this, or use a fair controller " +
          "(RandomController / MLController). Fair information-set MCTS is pending " +
          "the resumable engine.",
      );
    }
    this.program = opts.program;
    this.seed = opts.seed;
    this.players = opts.players;
    this.history = opts.history;
    this.sims = opts.simulations ?? 200;
    this.c = opts.c ?? 1.4;
    this.heuristic = opts.heuristic ?? false;
    this.rolloutDepth = opts.rolloutDepth ?? 40;
  }

  choose(req: ChoiceRequest, _obs: Observation): CSValue {
    const ourSeat = req.player.id;
    const prefixLen = this.history.length;
    const nodes = new Map<string, Node>();

    for (let s = 0; s < this.sims; s++) this.simulate(nodes, ourSeat, prefixLen, s);

    const root = nodes.get("");
    const opts = req.options;
    if (!root || root.children.size === 0) {
      return randomPick(req, new RNG((this.seed + prefixLen) >>> 0));
    }
    // robust child: most-visited action
    let bestKey = "";
    let best = -1;
    for (const [k, ch] of root.children) {
      if (ch.visits > best) {
        best = ch.visits;
        bestKey = k;
      }
    }
    return optionForKey(bestKey, opts);
  }

  private simulate(nodes: Map<string, Node>, ourSeat: number, prefixLen: number, idx: number): void {
    const rng = new RNG((this.seed * 7919 + prefixLen * 131 + idx * 17 + 1) >>> 0);
    const visited: { ps: string; key: string }[] = [];
    const path: string[] = [];
    let rollout = false;
    let rolloutSteps = 0;

    const decide = (req: ChoiceRequest, step: number): CSValue => {
      if (step < prefixLen) return translate(this.history[step], req);
      if (req.player.id !== ourSeat || rollout) {
        // in the random-rollout phase: optionally cut off and use the heuristic
        if (rollout && this.heuristic && ++rolloutSteps > this.rolloutDepth) throw CUTOFF;
        return randomPick(req, rng);
      }

      const ps = path.join("/");
      let node = nodes.get(ps);
      if (!node) {
        node = { visits: 0, children: new Map() };
        nodes.set(ps, node);
      }
      const opts = req.options;
      const keys = opts.map(keyOf);
      const untried = keys.filter((k) => !node!.children.has(k));

      let chosen: string;
      if (untried.length > 0) {
        chosen = untried[rng.int(untried.length)];
        node.children.set(chosen, { visits: 0, value: 0 });
        rollout = true; // expand exactly one node, then play out randomly
      } else {
        chosen = uctSelect(node, keys, this.c);
      }
      visited.push({ ps, key: chosen });
      path.push(chosen);
      return optionForKey(chosen, opts);
    };

    const out = playout(this.program, this.seed, this.players, decide);
    const reward = out.cutoff
      ? scoreReward(out.interp, out.state, ourSeat)
      : out.winners.some((p) => p.id === ourSeat) ? 1 : 0;

    for (const v of visited) {
      const n = nodes.get(v.ps) as Node;
      n.visits++;
      const ch = n.children.get(v.key) as Child;
      ch.visits++;
      ch.value += reward;
    }
  }
}

// thrown to abort a rollout at the depth limit (heuristic mode)
const CUTOFF = Symbol("cutoff");

interface PlayoutResult {
  cutoff: boolean;
  winners: Player[];
  interp: Interpreter;
  state: GameState;
}

// ---- a single synchronous playout of a fresh game ----
function playout(
  program: A.Program,
  seed: number,
  np: number,
  decide: (req: ChoiceRequest, step: number) => CSValue,
): PlayoutResult {
  const state = new GameState(np, seed);
  state.globals.set("__quiet", true); // silence log()/announce() inside playouts
  const interp = new Interpreter(program, state);
  const gen = interp.runGame();
  let step = 0;
  let next = gen.next();
  let guard = 0;
  try {
    while (!next.done) {
      if (++guard > 200000) break; // safety
      const ans = decide(next.value as ChoiceRequest, step);
      step++;
      next = gen.next(ans);
    }
  } catch (e) {
    if (e === CUTOFF) return { cutoff: true, winners: [], interp, state };
    throw e;
  }
  return { cutoff: false, winners: (next.value as Player[]) ?? [], interp, state };
}

// leaf value in [0,1]: the fraction of opponents our seat currently out-scores
// (ties count half). Uses the game's `score` heuristic at the cutoff position.
function scoreReward(interp: Interpreter, state: GameState, ourSeat: number): number {
  const mine = interp.scoreOf(state.players[ourSeat]);
  let beat = 0;
  let total = 0;
  for (const p of state.players) {
    if (p.id === ourSeat) continue;
    total++;
    const s = interp.scoreOf(p);
    if (mine > s) beat += 1;
    else if (mine === s) beat += 0.5;
  }
  return total > 0 ? beat / total : mine > 0 ? 1 : 0.5;
}

// ---- UCT selection ----
function uctSelect(node: Node, keys: string[], c: number): string {
  const lnN = Math.log(node.visits + 1);
  let best = keys[0];
  let bestScore = -Infinity;
  for (const k of keys) {
    const ch = node.children.get(k);
    if (!ch) continue;
    const exploit = ch.visits > 0 ? ch.value / ch.visits : 0;
    const explore = c * Math.sqrt(lnN / (ch.visits + 1e-9));
    const score = exploit + explore;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

// ---- option <-> stable key ----
function keyOf(raw: CSValue): string {
  const o = unwrap(raw);
  if (o === null) return "_";
  if (o instanceof Card) return "c" + o.id;
  if (o instanceof Player) return "p" + o.id;
  if (Array.isArray(o)) return "L" + o.map(keyOf).sort().join(",");
  if (typeof o === "number") return "n" + o;
  if (typeof o === "boolean") return o ? "bT" : "bF";
  return "s" + String(o);
}

function optionForKey(key: string, opts: CSValue[]): CSValue {
  for (const o of opts) if (keyOf(o) === key) return o;
  return key === "_" ? null : (opts[0] ?? null);
}

// map a recorded (real-game) answer onto the fresh game's equivalent option
function translate(rec: CSValue, req: ChoiceRequest): CSValue {
  if (rec === null) return null;
  if (typeof rec === "number" || typeof rec === "boolean" || typeof rec === "string") return rec;
  if (Array.isArray(rec)) return rec.map((c) => findByKey(req.options, c));
  return findByKey(req.options, rec);
}
function findByKey(options: CSValue[], o: CSValue): CSValue {
  const k = keyOf(o);
  for (const x of options) if (keyOf(x) === k) return x;
  return o;
}

// ---- random rollout policy ----
function randomPick(req: ChoiceRequest, rng: RNG): CSValue {
  if (req.options.length === 0) return null;
  return req.options[rng.int(req.options.length)];
}
