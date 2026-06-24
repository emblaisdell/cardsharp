// Controllers answer ChoiceRequests. Humans, bots, and ML agents are all just
// controllers — this is the single seam between the engine and a decision-maker.

import { isList } from "./values.ts";
import type { CSValue } from "./values.ts";
import type { ChoiceRequest } from "./choice.ts";
import type { Observation } from "./state.ts";
import { RNG } from "./rng.ts";

export interface Controller {
  choose(req: ChoiceRequest, obs: Observation): CSValue | Promise<CSValue>;
}

// Picks uniformly at random from the legal options, using its own seeded RNG so
// self-play is reproducible.
export class RandomController implements Controller {
  private rng: RNG;
  constructor(seed = 12345) {
    this.rng = new RNG(seed);
  }

  choose(req: ChoiceRequest): CSValue {
    switch (req.kind) {
      case "number": {
        const [lo, hi] = req.options as [number, number];
        return lo + this.rng.int(hi - lo + 1);
      }
      case "boolean":
        return this.rng.next() < 0.5;
      case "cards": {
        const min = req.min ?? 0;
        const max = Math.min(req.max ?? req.options.length, req.options.length);
        const k = min + this.rng.int(max - min + 1);
        const pool = [...req.options];
        this.rng.shuffle(pool);
        return pool.slice(0, k);
      }
      default: {
        // when declining is allowed, treat "none" as one more option
        const pool = req.allowNone ? [...req.options, null] : req.options;
        if (pool.length === 0) return null;
        return pool[this.rng.int(pool.length)];
      }
    }
  }
}

// Always picks the first legal option (handy for deterministic tests/replays).
export class FirstController implements Controller {
  choose(req: ChoiceRequest): CSValue {
    switch (req.kind) {
      case "number":
        return (req.options as number[])[0];
      case "boolean":
        return false;
      case "cards":
        return (req.options as CSValue[]).slice(0, req.min ?? 0);
      default:
        return req.options.length ? req.options[0] : null;
    }
  }
}

// Wraps a function (e.g. a policy/ML agent or a UI promise resolver).
export class FnController implements Controller {
  private fn: (req: ChoiceRequest, obs: Observation) => CSValue | Promise<CSValue>;
  constructor(fn: (req: ChoiceRequest, obs: Observation) => CSValue | Promise<CSValue>) {
    this.fn = fn;
  }
  choose(req: ChoiceRequest, obs: Observation): CSValue | Promise<CSValue> {
    return this.fn(req, obs);
  }
}

export function describeChoice(req: ChoiceRequest): string {
  const opts = isList(req.options) ? req.options.length : 0;
  return `${req.player.name} · ${req.kind} · ${opts} options${req.prompt ? ` · ${req.prompt}` : ""}`;
}
