// Fair Information-Set Monte-Carlo Tree Search for any ♠# game.
//
// At the searching player's decision it runs many iterations; each iteration:
//   1. clones the live resumable machine (a faithful continuation),
//   2. *determinizes* the clone from the searcher's OWN observation — the unseen
//      cards are reshuffled with a search-local RNG (never the game seed), so the
//      search only ever reasons over worlds consistent with what it can see,
//   3. descends a UCT tree over the searcher's future decisions (opponents and
//      chance are sampled), expands one node, then rolls out — depth-limited and
//      scored by the game's `score` heuristic so long games stay affordable.
// It is fair: no hidden information or seed ever enters the search.

import { Machine } from "../../core/src/vm.ts";
import { RNG, Card, Player, unwrap } from "../../core/src/index.ts";
import type { CSValue, ChoiceRequest, GameState } from "../../core/src/index.ts";
import type * as A from "../../core/src/ast.ts";

export interface IsmctsOptions {
  iterations?: number; // tree iterations per move
  rolloutDepth?: number; // searcher-decisions before the score cutoff
  c?: number; // UCT exploration constant
}

interface Child { visits: number; value: number; }
interface Node { visits: number; children: Map<string, Child>; }

// Choose an action at the machine's current decision for seat `ourSeat`.
export function ismctsAction(machine: Machine, ourSeat: number, opts: IsmctsOptions, rng: RNG): CSValue {
  const req = machine.currentRequest;
  if (!req) throw new Error("ismctsAction: machine is not at a decision");
  const realOptions = req.options;
  if (realOptions.length <= 1) return realOptions.length ? realOptions[0] : null;

  const iterations = opts.iterations ?? 100;
  const rolloutDepth = opts.rolloutDepth ?? 30;
  const c = opts.c ?? 1.4;
  const nodes = new Map<string, Node>();

  for (let it = 0; it < iterations; it++) {
    const sim = machine.clone();
    sim.state.globals.set("__quiet", true); // silence announce() during rollouts (perf)
    sim.state.determinizeInPlace(sim.state.players[ourSeat], new RNG((rng.int(1 << 30) ^ (it * 0x9e3779b1)) >>> 0));
    iterate(nodes, sim, ourSeat, rolloutDepth, c, rng);
  }

  const root = nodes.get("");
  if (!root || root.children.size === 0) return realOptions[rng.int(realOptions.length)];
  let bestKey = "";
  let best = -1;
  for (const [k, ch] of root.children) if (ch.visits > best) { best = ch.visits; bestKey = k; }
  return optionForKey(bestKey, realOptions);
}

function iterate(nodes: Map<string, Node>, sim: Machine, ourSeat: number, rolloutDepth: number, c: number, rng: RNG): void {
  const path: string[] = [];
  const visited: { ps: string; ck: string }[] = [];
  let rollout = false;
  let depth = 0;
  let res: { done: boolean; request?: ChoiceRequest; winners?: Player[] } = {
    done: sim.isDone,
    request: sim.currentRequest ?? undefined,
  };
  let guard = 0;
  while (!res.done) {
    if (++guard > 100000) break;
    const req = res.request as ChoiceRequest;
    let action: CSValue;
    if (req.player.id === ourSeat) {
      if (rollout) {
        if (++depth > rolloutDepth) {
          backprop(nodes, visited, scoreReward(sim, ourSeat));
          return;
        }
        action = req.options[rng.int(req.options.length)];
      } else {
        const ps = path.join("/");
        let node = nodes.get(ps);
        if (!node) { node = { visits: 0, children: new Map() }; nodes.set(ps, node); }
        const keys = req.options.map(keyOf);
        const untried = keys.filter((k) => !(node as Node).children.has(k));
        let ck: string;
        if (untried.length) { ck = untried[rng.int(untried.length)]; node.children.set(ck, { visits: 0, value: 0 }); rollout = true; }
        else ck = uctSelect(node, keys, c);
        visited.push({ ps, ck });
        path.push(ck);
        action = optionForKey(ck, req.options);
      }
    } else {
      action = req.options.length ? req.options[rng.int(req.options.length)] : null;
    }
    sim.supply(action);
    res = sim.next();
  }
  const reward = (res.winners as Player[]).some((p) => p.id === ourSeat) ? 1 : 0;
  backprop(nodes, visited, reward);
}

function backprop(nodes: Map<string, Node>, visited: { ps: string; ck: string }[], reward: number): void {
  for (const v of visited) {
    const n = nodes.get(v.ps) as Node;
    n.visits++;
    const ch = n.children.get(v.ck) as Child;
    ch.visits++;
    ch.value += reward;
  }
}

// leaf value in [0,1]: fraction of opponents the searcher currently out-scores
function scoreReward(sim: Machine, ourSeat: number): number {
  const mine = sim.scoreOf(sim.state.players[ourSeat]);
  let beat = 0;
  let total = 0;
  for (const p of sim.state.players) {
    if (p.id === ourSeat) continue;
    total++;
    const s = sim.scoreOf(p);
    if (mine > s) beat += 1;
    else if (mine === s) beat += 0.5;
  }
  return total ? beat / total : mine > 0 ? 1 : 0.5;
}

function uctSelect(node: Node, keys: string[], c: number): string {
  const lnN = Math.log(node.visits + 1);
  let best = keys[0];
  let bestScore = -Infinity;
  for (const k of keys) {
    const ch = node.children.get(k);
    if (!ch) continue;
    const exploit = ch.visits > 0 ? ch.value / ch.visits : 0;
    const explore = c * Math.sqrt(lnN / (ch.visits + 1e-9));
    const s = exploit + explore;
    if (s > bestScore) { bestScore = s; best = k; }
  }
  return best;
}

// Play a full game on the resumable machine where `ismctsSeat` is the fair
// IS-MCTS bot and the other seats play random. Returns the winners.
export function playIsmctsGame(
  program: A.Program,
  state: GameState,
  ismctsSeat: number,
  opts: IsmctsOptions,
  rng: RNG,
): Player[] {
  const m = new Machine(program, state, () => {
    throw new Error("vm decide should be unused during stepping");
  });
  let r = m.start();
  let guard = 0;
  while (!r.done) {
    if (++guard > 200000) break;
    const req = r.request as ChoiceRequest;
    const action =
      req.player.id === ismctsSeat
        ? ismctsAction(m, ismctsSeat, opts, rng)
        : req.options.length
          ? req.options[rng.int(req.options.length)]
          : null;
    m.supply(action);
    r = m.next();
  }
  return (r.winners as Player[]) ?? [];
}

function keyOf(o: CSValue): string {
  o = unwrap(o);
  if (o === null) return "_";
  if (o instanceof Card) return "c" + o.id;
  if (o instanceof Player) return "p" + o.id;
  if (Array.isArray(o)) return "L" + o.map(keyOf).sort().join(",");
  if (typeof o === "number") return "n" + o;
  if (typeof o === "boolean") return o ? "bT" : "bF";
  return "s" + String(o);
}
function optionForKey(k: string, options: CSValue[]): CSValue {
  for (const o of options) if (keyOf(o) === k) return o;
  return k === "_" ? null : (options[0] ?? null);
}
