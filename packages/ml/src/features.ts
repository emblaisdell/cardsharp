// Feature extraction for the classical-ML players.
//
// Each decision point is (ChoiceRequest, Observation). We turn every legal
// option into a fixed-length feature row φ(obs, option); the policy scores rows
// and picks one. Features are intentionally game-agnostic (they read the generic
// observation), so one model architecture works across every ♠# game.

import { Card, Player } from "../../core/src/index.ts";
import type { CSValue, ChoiceRequest, Observation } from "../../core/src/index.ts";

// ---- fixed feature layout ----
// kind one-hot (8) | card features (8) | player features (2) | scalar (2)
// | context (5) | bias (1)
const KINDS = ["player", "card", "cards", "rank", "suit", "option", "number", "boolean"] as const;
export const FEATURE_NAMES: string[] = [
  ...KINDS.map((k) => `kind:${k}`),
  "card:rank", "card:value", "card:isAce", "card:isFace", "card:suitC", "card:suitD", "card:suitH", "card:suitS",
  "player:visibleCards", "player:active",
  "scalar:num", "scalar:bool",
  "ctx:myHandSize", "ctx:myHandValue", "ctx:numOptions", "ctx:turn", "ctx:numActive",
  "bias",
];
export const DIM = FEATURE_NAMES.length;

// kinds the ML controller scores directly (option is indexable in req.options)
export const SCORABLE = new Set(["player", "card", "rank", "suit", "option", "boolean"]);

interface Context {
  myHandSize: number;
  myHandValue: number;
  numOptions: number;
  turn: number;
  numActive: number;
}

function context(obs: Observation, req: ChoiceRequest): Context {
  let myHandSize = 0;
  let myHandValue = 0;
  for (const v of Object.values(obs.zones)) {
    const piles = Array.isArray(v) ? v : [v];
    for (const pile of piles) {
      if (pile.owner !== obs.viewer) continue;
      for (const c of pile.cards) {
        if (c) {
          myHandSize += 1;
          myHandValue += c.value;
        }
      }
    }
  }
  const numActive = obs.players.filter((p) => !p.out).length;
  return {
    myHandSize,
    myHandValue,
    numOptions: req.options.length,
    turn: obs.turn,
    numActive,
  };
}

// total cards a given player has visible to us (a public-information proxy)
function visibleCardsOf(obs: Observation, playerId: number): number {
  let n = 0;
  for (const v of Object.values(obs.zones)) {
    const piles = Array.isArray(v) ? v : [v];
    for (const pile of piles) {
      if (pile.owner === playerId) n += pile.size;
    }
  }
  return n;
}

export function featurizeOption(
  option: CSValue,
  ctx: Context,
  obs: Observation,
  kind: ChoiceRequest["kind"],
  req: ChoiceRequest,
): number[] {
  const f = new Array(DIM).fill(0);
  let i = 0;

  // kind one-hot
  const ki = KINDS.indexOf(kind as (typeof KINDS)[number]);
  if (ki >= 0) f[i + ki] = 1;
  i += KINDS.length;

  // card features
  if (option instanceof Card) {
    f[i + 0] = option.rank / 13;
    f[i + 1] = option.value / 14;
    f[i + 2] = option.rank === 1 ? 1 : 0;
    f[i + 3] = option.rank >= 11 ? 1 : 0;
    f[i + 4 + option.suit] = 1;
  }
  i += 8;

  // player features
  if (option instanceof Player) {
    f[i + 0] = visibleCardsOf(obs, option.id) / 20;
    f[i + 1] = option.eliminated ? 0 : 1;
  }
  i += 2;

  // scalar features (rank/suit/number are plain numbers; boolean is true/false)
  if (typeof option === "number") {
    const lo = kind === "number" ? (req.options[0] as number) : 0;
    const hi = kind === "number" ? (req.options[1] as number) : 13;
    f[i + 0] = hi > lo ? (option - lo) / (hi - lo) : option / 13;
  }
  if (typeof option === "boolean") f[i + 1] = option ? 1 : 0;
  i += 2;

  // shared context
  f[i + 0] = ctx.myHandSize / 20;
  f[i + 1] = ctx.myHandValue / 60;
  f[i + 2] = ctx.numOptions / 10;
  f[i + 3] = ctx.turn / 50;
  f[i + 4] = ctx.numActive / 6;
  i += 5;

  f[i] = 1; // bias
  return f;
}

// One feature row per legal option (only meaningful for SCORABLE kinds). When
// the request allows declining, a trailing "none" row is appended.
export function featurizeOptions(req: ChoiceRequest, obs: Observation): number[][] {
  const ctx = context(obs, req);
  const opts = req.allowNone ? [...req.options, null] : req.options;
  return opts.map((o) => featurizeOption(o, ctx, obs, req.kind, req));
}
