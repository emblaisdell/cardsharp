// Neural-guided Information-Set MCTS — the hybrid recommended in
// docs/ml-research.md (#2): AlphaZero/ReBeL-style search that replaces IS-MCTS's
// uniform priors + random rollouts with a trained net.
//
// Each iteration (fair — only the searcher's own observation is ever used):
//   1. clone the live machine, determinize unseen cards from the searcher's view,
//   2. descend the tree of the searcher's decisions using PUCT, where the net
//      supplies the per-action PRIOR P(a),
//   3. at the first unexpanded searcher node, EVALUATE the net (no rollout): take
//      its leaf VALUE V(s) ∈ [0,1] and back it up. Terminal nodes back up the
//      real win/loss. Opponents/chance are sampled (uniform by default).
//
// The net is evaluated on the searcher's masked observation, which is identical
// across determinizations — i.e. it scores the information set, exactly right for
// IS-MCTS.

import { Machine } from "../../core/src/vm.ts";
import { RNG, Card, Player, unwrap } from "../../core/src/index.ts";
import type { CSValue, ChoiceRequest } from "../../core/src/index.ts";
import { NetPlayer } from "./netplay.ts";

export interface NeuralIsmctsOptions {
  iterations?: number;
  c?: number;          // PUCT exploration constant
  priorTemp?: number;  // temperature applied to the net prior
  netOpponents?: boolean; // sample opponents from the net policy (else uniform)
  // leaf value: "net" = AlphaZero-style net value (best where the net value beats
  // the game's score heuristic); "rollout" = keep IS-MCTS's depth-limited rollout
  // scored by the `score` heuristic, and use the net only as the PUCT prior (best
  // where the score heuristic is already strong). Default "rollout".
  leaf?: "net" | "rollout";
  rolloutDepth?: number;
}

interface Child { visits: number; value: number; prior: number; }
interface Node { visits: number; children: Map<string, Child>; }

export function neuralIsmctsAction(
  machine: Machine,
  ourSeat: number,
  net: NetPlayer,
  opts: NeuralIsmctsOptions,
  rng: RNG,
): CSValue {
  const req = machine.currentRequest;
  if (!req) throw new Error("neuralIsmctsAction: machine is not at a decision");
  const realOptions = req.options;
  if (realOptions.length <= 1) return realOptions.length ? realOptions[0] : null;

  const iterations = opts.iterations ?? 100;
  const c = opts.c ?? 1.5;
  const priorTemp = opts.priorTemp ?? 0.15;
  const netOpp = opts.netOpponents ?? false;
  const leaf = opts.leaf ?? "rollout";
  const rolloutDepth = opts.rolloutDepth ?? 20;
  const nodes = new Map<string, Node>();

  for (let it = 0; it < iterations; it++) {
    const sim = machine.clone();
    sim.state.globals.set("__quiet", true);
    sim.state.determinizeInPlace(sim.state.players[ourSeat],
      new RNG((rng.int(1 << 30) ^ (it * 0x9e3779b1)) >>> 0));
    iterate(nodes, sim, ourSeat, net, c, priorTemp, netOpp, leaf, rolloutDepth, rng);
  }

  const root = nodes.get("");
  if (!root || root.children.size === 0) return realOptions[rng.int(realOptions.length)];
  let bestKey = "";
  let best = -1;
  for (const [k, ch] of root.children) if (ch.visits > best) { best = ch.visits; bestKey = k; }
  return optionForKey(bestKey, realOptions);
}

function iterate(
  nodes: Map<string, Node>, sim: Machine, ourSeat: number, net: NetPlayer,
  c: number, priorTemp: number, netOpp: boolean, leaf: string, rolloutDepth: number, rng: RNG,
): void {
  const path: string[] = [];
  const visited: { ps: string; ck: string }[] = [];
  let res: { done: boolean; request?: ChoiceRequest; winners?: Player[] } = {
    done: sim.isDone, request: sim.currentRequest ?? undefined,
  };
  let guard = 0;
  while (!res.done) {
    if (++guard > 100000) break;
    const req = res.request as ChoiceRequest;
    let action: CSValue;
    if (req.player.id === ourSeat) {
      const ps = path.join("/");
      let node = nodes.get(ps);
      if (!node) {
        // leaf: seed child priors from the net; value from the net OR a rollout
        const obs = sim.state.observe(sim.state.players[ourSeat]);
        const { priors, value } = net.policyValue(req, obs, priorTemp);
        const children = new Map<string, Child>();
        req.options.forEach((o, i) => children.set(keyOf(o), { visits: 0, value: 0, prior: priors[i] ?? 0 }));
        nodes.set(ps, { visits: 0, children });
        const leafValue = leaf === "net" ? value : rollout(sim, ourSeat, rolloutDepth, rng);
        backprop(nodes, visited, leafValue);
        return;
      }
      const keys = req.options.map(keyOf);
      // a different determinization can surface options this node hasn't seen;
      // add them lazily (uniform prior) so PUCT/backprop always have a child.
      for (const k of keys) {
        if (!node.children.has(k)) node.children.set(k, { visits: 0, value: 0, prior: 1 / keys.length });
      }
      const ck = puctSelect(node, keys, c);
      visited.push({ ps, ck });
      path.push(ck);
      action = optionForKey(ck, req.options);
    } else if (netOpp && req.options.length > 1) {
      // model the opponent as a net-strength player in this determinized world
      const obs = sim.state.observe(req.player);
      const { priors } = net.policyValue(req, obs, priorTemp);
      action = sampleByPrior(req.options, priors, rng);
    } else {
      action = req.options.length ? req.options[rng.int(req.options.length)] : null;
    }
    sim.supply(action);
    res = sim.next();
  }
  const reward = (res.winners as Player[]).some((p) => p.id === ourSeat) ? 1 : 0;
  backprop(nodes, visited, reward);
}

// depth-limited random rollout scored by the game's `score` heuristic (identical
// to plain IS-MCTS), so the hybrid keeps a strong leaf value where the heuristic
// is good and only adds the net's PUCT prior on top.
function rollout(sim: Machine, ourSeat: number, rolloutDepth: number, rng: RNG): number {
  let depth = 0;
  let res: { done: boolean; request?: ChoiceRequest; winners?: Player[] } = {
    done: sim.isDone, request: sim.currentRequest ?? undefined,
  };
  let guard = 0;
  while (!res.done) {
    if (++guard > 100000) break;
    const req = res.request as ChoiceRequest;
    if (req.player.id === ourSeat && ++depth > rolloutDepth) return scoreReward(sim, ourSeat);
    const action = req.options.length ? req.options[rng.int(req.options.length)] : null;
    sim.supply(action);
    res = sim.next();
  }
  return (res.winners as Player[]).some((p) => p.id === ourSeat) ? 1 : 0;
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

function puctSelect(node: Node, keys: string[], c: number): string {
  const sqrtN = Math.sqrt(node.visits + 1);
  let best = keys[0];
  let bestS = -Infinity;
  for (const k of keys) {
    const ch = node.children.get(k);
    if (!ch) continue;
    const q = ch.visits > 0 ? ch.value / ch.visits : 0;
    const u = c * ch.prior * sqrtN / (1 + ch.visits);
    const s = q + u;
    if (s > bestS) { bestS = s; best = k; }
  }
  return best;
}

function sampleByPrior(options: CSValue[], priors: number[], rng: RNG): CSValue {
  let r = rng.next();
  for (let i = 0; i < options.length; i++) {
    r -= priors[i] ?? 0;
    if (r <= 0) return options[i];
  }
  return options[options.length - 1];
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
