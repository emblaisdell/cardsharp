// An ML player: a Controller backed by a LinearPolicy. In play mode it picks the
// argmax option; in training mode it samples (softmax) and records the decision
// so the trainer can apply a policy-gradient update.

import { RNG } from "../../core/src/index.ts";
import type { Controller, CSValue, ChoiceRequest, Observation } from "../../core/src/index.ts";
import { LinearPolicy } from "./policy.ts";
import { featurizeOptions } from "./features.ts";

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
    if (req.options.length === 0) return null;
    // every decision is now scorable: one feature row per legal option (the
    // `null` decline option, if any, is just another row).
    const rows = featurizeOptions(req, obs);
    const idx =
      this.temperature > 0
        ? this.policy.sample(rows, this.temperature, () => this.rng.next())
        : this.policy.argmax(rows);
    this.record?.({ rows, chosen: idx });
    return req.options[idx];
  }
}
