// An ML player: a Controller backed by a LinearPolicy. In play mode it picks the
// argmax option; in training mode it samples (softmax) and records the decision
// so the trainer can apply a policy-gradient update.

import { RNG } from "../../core/src/index.ts";
import type { Controller, CSValue, ChoiceRequest, Observation } from "../../core/src/index.ts";
import { LinearPolicy } from "./policy.ts";
import { featurizeOptions, SCORABLE } from "./features.ts";

export interface Decision {
  rows: number[][];
  chosen: number;
}

export interface MLOptions {
  temperature?: number; // 0 => greedy argmax (play); > 0 => sample (train)
  seed?: number;
  record?: (d: Decision) => void;
}

export class MLController implements Controller {
  policy: LinearPolicy;
  private temperature: number;
  private rng: RNG;
  private record?: (d: Decision) => void;

  constructor(policy: LinearPolicy, opts: MLOptions = {}) {
    this.policy = policy;
    this.temperature = opts.temperature ?? 0;
    this.rng = new RNG(opts.seed ?? 1);
    this.record = opts.record;
  }

  choose(req: ChoiceRequest, obs: Observation): CSValue {
    if (!SCORABLE.has(req.kind)) return this.fallback(req);
    const rows = featurizeOptions(req, obs);
    const idx =
      this.temperature > 0
        ? this.policy.sample(rows, this.temperature, () => this.rng.next())
        : this.policy.argmax(rows);
    this.record?.({ rows, chosen: idx });
    // a trailing index past the real options is the "none"/decline slot
    if (req.allowNone && idx === req.options.length) return null;
    return req.options[idx];
  }

  // kinds the linear model doesn't score (multi-select / numeric range)
  private fallback(req: ChoiceRequest): CSValue {
    if (req.kind === "number") {
      const [lo, hi] = req.options as [number, number];
      return lo + this.rng.int(hi - lo + 1);
    }
    if (req.kind === "cards") {
      const min = req.min ?? 0;
      const max = Math.min(req.max ?? req.options.length, req.options.length);
      const k = min + this.rng.int(max - min + 1);
      const pool = [...req.options];
      this.rng.shuffle(pool);
      return pool.slice(0, k);
    }
    return req.options.length ? req.options[this.rng.int(req.options.length)] : null;
  }
}
