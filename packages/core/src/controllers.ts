// Controllers answer ChoiceRequests. Humans, bots, and ML agents are all just
// controllers — this is the single seam between the engine and a decision-maker.

import { display } from "./values.ts";
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
    if (req.options.length === 0) return null;
    return req.options[this.rng.int(req.options.length)];
  }
}

// Always picks the first legal option (handy for deterministic tests/replays).
export class FirstController implements Controller {
  choose(req: ChoiceRequest): CSValue {
    return req.options.length ? req.options[0] : null;
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
  const opts = req.options.map(display).join(", ");
  return `${req.player.name} · ${req.options.length} options [${opts}]${req.prompt ? ` · ${req.prompt}` : ""}`;
}
