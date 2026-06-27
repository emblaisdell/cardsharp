// Feature extraction for the classical-ML players.
//
// Each decision point is (ChoiceRequest, Observation). We turn every legal
// option into a fixed-length feature row φ(obs, option); the policy scores rows
// and picks one. Features are intentionally game-agnostic (they read the generic
// observation), so one model architecture works across every ♠# game.

import { Card, Player, unwrap } from "../../core/src/index.ts";
import type { CSValue, ChoiceRequest, Observation } from "../../core/src/index.ts";

// ---- fixed feature layout ----
// value-kind one-hot (8) | card features (8) | player features (2) | scalar (2)
// | context (5) | bias (1)
//
// There is no per-call "kind" anymore: every decision is a `choose` over a list
// of options, and we featurize each option from its own runtime value. The
// one-hot below classifies that value (`labeled` wrappers are stripped first).
const VALUE_KINDS = [
  "player", "card", "list", "number", "boolean", "string", "none", "other",
] as const;
type ValueKind = (typeof VALUE_KINDS)[number];

function valueKind(option: CSValue): ValueKind {
  if (option === null) return "none";
  if (option instanceof Card) return "card";
  if (option instanceof Player) return "player";
  if (Array.isArray(option)) return "list";
  if (typeof option === "number") return "number";
  if (typeof option === "boolean") return "boolean";
  if (typeof option === "string") return "string";
  return "other";
}

export const FEATURE_NAMES: string[] = [
  ...VALUE_KINDS.map((k) => `vk:${k}`),
  "card:rank", "card:value", "card:isAce", "card:isFace", "card:suitC", "card:suitD", "card:suitH", "card:suitS",
  "player:visibleCards", "player:active",
  "scalar:num", "scalar:bool",
  "ctx:myHandSize", "ctx:myHandValue", "ctx:numOptions", "ctx:turn", "ctx:numActive",
  "bias",
];
export const DIM = FEATURE_NAMES.length;

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
  rawOption: CSValue,
  ctx: Context,
  obs: Observation,
): number[] {
  // a `labeled(...)` option is scored on the value it wraps, not its label
  const option = unwrap(rawOption);
  const f = new Array(DIM).fill(0);
  let i = 0;

  // value-kind one-hot
  const ki = VALUE_KINDS.indexOf(valueKind(option));
  if (ki >= 0) f[i + ki] = 1;
  i += VALUE_KINDS.length;

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

  // scalar features (a bare number option — e.g. a rank; boolean is true/false)
  if (typeof option === "number") f[i + 0] = option / 13;
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

// One feature row per legal option (including any `null` decline option, which
// the game lists explicitly). Row index i corresponds to req.options[i].
export function featurizeOptions(req: ChoiceRequest, obs: Observation): number[][] {
  const ctx = context(obs, req);
  return req.options.map((o) => featurizeOption(o, ctx, obs));
}
