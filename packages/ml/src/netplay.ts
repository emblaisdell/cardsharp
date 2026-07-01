// Load a DMC/PPO net trained by packages/pyengine (exported to .netjson) and play
// it inside the TS engine, so the learned non-tree-search policy can face the fair
// Information-Set MCTS. The card-matrix state encoder mirrors pyengine/ml/features.py
// (state_features); the per-option features reuse this package's featurizeOptions,
// which is bit-for-bit the same 26-d layout the Python side trained on.

import { featurizeOptions } from "./features.ts";
import type { ChoiceRequest, Observation, CSValue } from "../../core/src/index.ts";

interface NetJSON {
  hidden: number;
  state_dim: number;
  option_dim: number;
  method: string;
  trunk0_w: number[][]; trunk0_b: number[];
  trunk2_w: number[][]; trunk2_b: number[];
  scorer0_w: number[][]; scorer0_b: number[];
  scorer2_w: number[][]; scorer2_b: number[];
  value_w: number[][]; value_b: number[];
}

function linear(W: number[][], b: number[], x: number[]): number[] {
  const out = new Array(W.length);
  for (let o = 0; o < W.length; o++) {
    let s = b[o];
    const row = W[o];
    for (let i = 0; i < row.length; i++) s += row[i] * x[i];
    out[o] = s;
  }
  return out;
}
function relu(a: number[]): number[] {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] > 0 ? a[i] : 0;
  return out;
}

// Port of pyengine/ml/features.py `state_features` (117 dims):
// my-cards 4x13 (/4) | all-visible 4x13 (/4) | rel seat counts (6, /20) | 7 scalars
export function stateFeatures(obs: Observation): number[] {
  const my = new Array(52).fill(0);
  const vis = new Array(52).fill(0);
  const seat = new Array(6).fill(0);
  let hs = 0;
  let hv = 0;
  const viewer = obs.viewer;
  for (const v of Object.values(obs.zones)) {
    const piles = Array.isArray(v) ? v : [v];
    for (const pile of piles) {
      const owner = pile.owner;
      if (owner != null && owner >= 0 && owner < 6) seat[owner] += pile.size;
      for (const c of pile.cards) {
        if (c) {
          const idx = c.suit * 13 + (c.rank - 1);
          vis[idx] += 1;
          if (owner === viewer) {
            my[idx] += 1;
            hs += 1;
            hv += c.value;
          }
        }
      }
    }
  }
  const numActive = obs.players.filter((p) => !p.out).length;
  const numPlayers = obs.players.length;
  const out: number[] = [];
  for (const x of my) out.push(x / 4);
  for (const x of vis) out.push(x / 4);
  for (let s = 0; s < 6; s++) out.push(seat[(viewer + s) % 6] / 20);
  out.push(hs / 20, hv / 60, obs.turn / 50, numActive / 6, numPlayers / 6, viewer / 6, obs.current / 6);
  return out; // 117
}

export class NetPlayer {
  net: NetJSON;
  constructor(net: NetJSON) {
    this.net = net;
  }
  static fromJSON(net: NetJSON): NetPlayer {
    return new NetPlayer(net);
  }

  private embed(sf: number[]): number[] {
    let h = relu(linear(this.net.trunk0_w, this.net.trunk0_b, sf));
    h = relu(linear(this.net.trunk2_w, this.net.trunk2_b, h));
    return h;
  }
  private scoreOption(h: number[], opt: number[]): number {
    const x = h.concat(opt);
    const hid = relu(linear(this.net.scorer0_w, this.net.scorer0_b, x));
    let s = this.net.scorer2_b[0];
    const row = this.net.scorer2_w[0];
    for (let i = 0; i < row.length; i++) s += row[i] * hid[i];
    return s;
  }

  // greedy: highest-scoring legal option (Q for DMC, logit for PPO)
  choose(req: ChoiceRequest, obs: Observation): CSValue {
    const h = this.embed(stateFeatures(obs));
    const rows = featurizeOptions(req, obs);
    let best = 0;
    let bestS = -Infinity;
    for (let i = 0; i < req.options.length; i++) {
      const s = this.scoreOption(h, rows[i]);
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    }
    return req.options[best];
  }

  private isDMC(): boolean {
    return (this.net.method || "").toUpperCase() === "DMC";
  }

  // For neural-guided search: a PUCT prior over the legal options (softmax of the
  // scorer outputs) and a leaf value estimate V in [0,1].
  //   - prior: softmax(scores / priorTemp)
  //   - value: DMC -> max-Q (the scorer already predicts win prob per action);
  //            PPO -> the trained value head.
  policyValue(req: ChoiceRequest, obs: Observation, priorTemp = 0.15):
      { priors: number[]; value: number } {
    const h = this.embed(stateFeatures(obs));
    const rows = featurizeOptions(req, obs);
    const scores = rows.map((r) => this.scoreOption(h, r));
    const m = Math.max(...scores);
    const e = scores.map((s) => Math.exp((s - m) / Math.max(priorTemp, 1e-6)));
    const z = e.reduce((a, b) => a + b, 0) || 1;
    const priors = e.map((x) => x / z);
    let value: number;
    if (this.isDMC()) {
      value = Math.max(...scores); // Q ~ P(win | action)
    } else {
      let v = this.net.value_b[0];
      const row = this.net.value_w[0];
      for (let i = 0; i < row.length; i++) v += row[i] * h[i];
      value = v;
    }
    value = value < 0 ? 0 : value > 1 ? 1 : value; // clamp to [0,1]
    return { priors, value };
  }
}
