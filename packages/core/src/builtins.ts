// The ♠# standard library: domain builtins for players, zones, movement,
// collections, card logic, and decisions.
//
// Every builtin is a generator so it can (a) call user lambdas via `yield*` and
// (b) `yield` a ChoiceRequest at a decision point. Pure builtins simply never
// yield.

import {
  Card,
  Pile,
  Player,
  Labeled,
  isCallable,
  isList,
  isZoneHandle,
  truthy,
  typeName,
  display,
  unwrap,
  CSRecord,
  RANK_NAMES,
  SUIT_NAMES,
} from "./values.ts";
import type { Callable, CSValue, ZoneHandle } from "./values.ts";
import type { GameState } from "./state.ts";
import { GameOver, RuntimeError } from "./signals.ts";
import type { ChoiceRequest } from "./choice.ts";
import type { Eval } from "./interpreter.ts";

type GenFn = (args: CSValue[]) => Eval<CSValue>;

export function makeBuiltins(state: GameState): Map<string, Callable> {
  const reg = new Map<string, Callable>();
  const def = (name: string, fn: GenFn): void => {
    reg.set(name, { call: true, name, invoke: fn });
  };

  // ---- helpers (host-side, not exposed) ----
  const asPile = (v: CSValue, who: string): Pile => {
    if (isZoneHandle(v) && v.zone === "pile") return v.pile;
    if (isZoneHandle(v) && v.zone === "family")
      throw new RuntimeError(`${who}: per-player zone must be indexed, e.g. hand[player]`);
    throw new RuntimeError(`${who}: expected a zone, got ${typeName(v)}`);
  };
  const asList = (v: CSValue, who: string): CSValue[] => {
    if (isList(v)) return v;
    throw new RuntimeError(`${who}: expected a list, got ${typeName(v)}`);
  };
  const asPlayer = (v: CSValue, who: string): Player => {
    if (v instanceof Player) return v;
    throw new RuntimeError(`${who}: expected a player, got ${typeName(v)}`);
  };
  const asCardList = (v: CSValue, who: string): Card[] => {
    if (v instanceof Card) return [v];
    if (isList(v)) return v.filter((x): x is Card => x instanceof Card);
    throw new RuntimeError(`${who}: expected card(s), got ${typeName(v)}`);
  };
  // Remove a card from whatever pile currently holds it.
  const removeCard = (card: Card): void => {
    for (const pile of state.sharedPiles.values()) {
      const i = pile.cards.findIndex((c) => c.id === card.id);
      if (i >= 0) {
        pile.cards.splice(i, 1);
        return;
      }
    }
    for (const piles of state.perPlayerPiles.values()) {
      for (const pile of piles) {
        const i = pile.cards.findIndex((c) => c.id === card.id);
        if (i >= 0) {
          pile.cards.splice(i, 1);
          return;
        }
      }
    }
  };
  // call a user lambda/function as part of a generator builtin
  function* callFn(fn: CSValue, args: CSValue[]): Eval<CSValue> {
    if (!isCallable(fn)) throw new RuntimeError(`expected a function, got ${typeName(fn)}`);
    return yield* fn.invoke(args) as Eval<CSValue>;
  }
  const keyNum = function* (fn: CSValue, item: CSValue): Eval<number> {
    const v = yield* callFn(fn, [item]);
    if (typeof v !== "number") throw new RuntimeError(`key must yield a number, got ${typeName(v)}`);
    return v;
  };

  // wrap a non-generator implementation
  const pure = (name: string, fn: (args: CSValue[]) => CSValue): void => {
    def(name, function* (args) {
      return fn(args);
    });
  };

  // =====================================================================
  // Deck / setup
  // =====================================================================
  pure("loadDeck", (args) => {
    const pile = asPile(args[0], "loadDeck");
    state.buildStandard52(pile);
    return null;
  });
  def("setValues", function* (args) {
    const fn = args[0];
    const apply = function* (pile: Pile): Eval<void> {
      for (const c of pile.cards) {
        const v = yield* callFn(fn, [c]);
        if (typeof v === "number") c.value = v;
      }
    };
    for (const pile of state.sharedPiles.values()) yield* apply(pile);
    for (const piles of state.perPlayerPiles.values()) for (const p of piles) yield* apply(p);
    return null;
  });

  // =====================================================================
  // Players & turns
  // =====================================================================
  pure("others", (args) => {
    const p = asPlayer(args[0], "others");
    const n = state.players.length;
    const out: Player[] = [];
    for (let k = 1; k < n; k++) out.push(state.players[(p.id + k) % n]);
    return out;
  });
  pure("playerAfter", (args) => state.nextActiveAfter(asPlayer(args[0], "playerAfter")));
  pure("endTurn", () => {
    state.turnCount++;
    state.current = state.nextActiveAfter(state.current);
    return null;
  });
  pure("nextPlayer", () => {
    state.current = state.nextActiveAfter(state.current);
    return state.current;
  });
  pure("setCurrent", (args) => {
    state.current = asPlayer(args[0], "setCurrent");
    return null;
  });
  pure("eliminate", (args) => {
    asPlayer(args[0], "eliminate").eliminated = true;
    return null;
  });
  pure("isActive", (args) => !asPlayer(args[0], "isActive").eliminated);
  pure("active", () => state.activePlayers());
  pure("turnIndex", () => state.turnCount);
  pure("declareWinner", (args) => {
    state.declaredWinners = [asPlayer(args[0], "declareWinner")];
    return null;
  });
  pure("declareWinners", (args) => {
    state.declaredWinners = asList(args[0], "declareWinners").filter(
      (x): x is Player => x instanceof Player,
    );
    return null;
  });
  pure("endGame", () => {
    throw new GameOver();
  });

  // =====================================================================
  // Zones & movement
  // =====================================================================
  pure("size", (args) => asPile(args[0], "size").cards.length);
  pure("cards", (args) => [...asPile(args[0], "cards").cards]);
  pure("isEmpty", (args) => asPile(args[0], "isEmpty").cards.length === 0);
  pure("top", (args) => {
    const pile = asPile(args[0], "top");
    const n = args.length > 1 ? num(args[1]) : 1;
    return pile.cards.slice(0, n);
  });
  pure("bottom", (args) => {
    const pile = asPile(args[0], "bottom");
    const n = args.length > 1 ? num(args[1]) : 1;
    return pile.cards.slice(Math.max(0, pile.cards.length - n));
  });
  pure("shuffle", (args) => {
    state.rng.shuffle(asPile(args[0], "shuffle").cards);
    return null;
  });
  pure("move", (args) => {
    const cards = asCardList(args[0], "move");
    const to = asPile(args[1], "move");
    for (const c of cards) {
      removeCard(c);
      to.cards.unshift(c); // onto the top
    }
    return null;
  });
  pure("moveTo", (args) => {
    const cards = asCardList(args[0], "moveTo");
    const to = asPile(args[1], "moveTo");
    const where = args.length > 2 ? String(args[2]) : "top";
    for (const c of cards) {
      removeCard(c);
      if (where === "bottom") to.cards.push(c);
      else to.cards.unshift(c);
    }
    return null;
  });
  pure("draw", (args) => {
    const from = asPile(args[0], "draw");
    const to = asPile(args[1], "draw");
    const n = args.length > 2 ? num(args[2]) : 1;
    const moved = from.cards.splice(0, n);
    for (const c of moved) to.cards.push(c);
    return moved;
  });
  pure("deal", (args) => {
    // deal(from, to, n): if `to` is a per-player family, deal n to each player;
    // if `to` is a single pile, move n total.
    const from = asPile(args[0], "deal");
    const toHandle = args[1] as ZoneHandle;
    const n = num(args[2]);
    if (isZoneHandle(toHandle) && toHandle.zone === "family") {
      for (let k = 0; k < n; k++) {
        for (const pile of toHandle.piles) {
          const c = from.cards.shift();
          if (!c) return null;
          pile.cards.push(c);
        }
      }
    } else {
      const to = asPile(args[1], "deal");
      for (let k = 0; k < n; k++) {
        const c = from.cards.shift();
        if (!c) break;
        to.cards.push(c);
      }
    }
    return null;
  });

  // =====================================================================
  // Collections / functional
  // =====================================================================
  pure("count", (args) => asList(args[0], "count").length);
  def("countIf", function* (args) {
    const list = asList(args[0], "countIf");
    let n = 0;
    for (const x of list) if (truthy(yield* callFn(args[1], [x]))) n++;
    return n;
  });
  def("filter", function* (args) {
    const list = asList(args[0], "filter");
    const out: CSValue[] = [];
    for (const x of list) if (truthy(yield* callFn(args[1], [x]))) out.push(x);
    return out;
  });
  def("map", function* (args) {
    const list = asList(args[0], "map");
    const out: CSValue[] = [];
    for (const x of list) out.push(yield* callFn(args[1], [x]));
    return out;
  });
  def("any", function* (args) {
    for (const x of asList(args[0], "any")) if (truthy(yield* callFn(args[1], [x]))) return true;
    return false;
  });
  def("all", function* (args) {
    for (const x of asList(args[0], "all")) if (!truthy(yield* callFn(args[1], [x]))) return false;
    return true;
  });
  def("none", function* (args) {
    for (const x of asList(args[0], "none")) if (truthy(yield* callFn(args[1], [x]))) return false;
    return true;
  });
  def("sum", function* (args) {
    const list = asList(args[0], "sum");
    let s = 0;
    for (const x of list) s += args[1] ? yield* keyNum(args[1], x) : num(x);
    return s;
  });
  def("maxBy", function* (args) {
    return yield* extreme(args, "maxBy", 1);
  });
  def("minBy", function* (args) {
    return yield* extreme(args, "minBy", -1);
  });
  def("sortBy", function* (args) {
    const list = [...asList(args[0], "sortBy")];
    const keys = new Map<CSValue, number>();
    for (const x of list) keys.set(x, yield* keyNum(args[1], x));
    list.sort((a, b) => (keys.get(a) as number) - (keys.get(b) as number));
    return list;
  });
  // max/min: numeric over args, or reduce a single list (optionally with key)
  def("max", function* (args) {
    return yield* reduceMinMax(args, 1);
  });
  def("min", function* (args) {
    return yield* reduceMinMax(args, -1);
  });
  pure("reverse", (args) => [...asList(args[0], "reverse")].reverse());
  pure("first", (args) => {
    const l = asList(args[0], "first");
    return l.length ? l[0] : null;
  });
  pure("last", (args) => {
    const l = asList(args[0], "last");
    return l.length ? l[l.length - 1] : null;
  });
  pure("take", (args) => asList(args[0], "take").slice(0, num(args[1])));
  pure("drop", (args) => asList(args[0], "drop").slice(num(args[1])));
  pure("concat", (args) => [...asList(args[0], "concat"), ...asList(args[1], "concat")]);
  pure("contains", (args) => {
    const list = asList(args[0], "contains");
    const x = args[1];
    return list.some((y) => sameValue(x, y));
  });
  pure("unique", (args) => {
    const list = asList(args[0], "unique");
    const out: CSValue[] = [];
    for (const x of list) if (!out.some((y) => sameValue(x, y))) out.push(x);
    return out;
  });
  pure("range", (args) => {
    const lo = num(args[0]);
    const hi = num(args[1]);
    const out: CSValue[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  });
  def("groupBy", function* (args) {
    const list = asList(args[0], "groupBy");
    const rec = new CSRecord();
    for (const x of list) {
      const k = String(yield* callFn(args[1], [x]));
      const cur = rec.get(k);
      if (isList(cur)) cur.push(x);
      else rec.set(k, [x]);
    }
    return rec;
  });

  // =====================================================================
  // Card helpers
  // =====================================================================
  pure("ranksOf", (args) => uniqueSortedNums(asCardList(args[0], "ranksOf").map((c) => c.rank)));
  pure("suitsOf", (args) => uniqueSortedNums(asCardList(args[0], "suitsOf").map((c) => c.suit)));
  // display names for a bare rank (1..13) or suit (0..3) number — handy for
  // labelling rank/suit `choose` options, e.g. `labeled(r, rankName(r))`.
  pure("rankName", (args) => RANK_NAMES[num(args[0])] ?? String(num(args[0])));
  pure("suitName", (args) => SUIT_NAMES[num(args[0])] ?? String(num(args[0])));
  pure("sameRank", (args) => {
    const cs = asCardList(args[0], "sameRank");
    return cs.length === 0 || cs.every((c) => c.rank === cs[0].rank);
  });
  pure("sameSuit", (args) => {
    const cs = asCardList(args[0], "sameSuit");
    return cs.length === 0 || cs.every((c) => c.suit === cs[0].suit);
  });
  pure("isRun", (args) => {
    // accepts a list of cards or a list of rank numbers
    const wrap = args.length > 1 ? truthy(args[1]) : false;
    return isRunOfRanks(toRanks(args[0]), wrap);
  });
  // all books (>=2 same rank) and maximal runs (>=2 same suit, consecutive,
  // ace-wrapping) found in a list of cards; each meld is a list of cards.
  pure("findMelds", (args) => {
    const cs = asCardList(args[0], "findMelds");
    const melds: Card[][] = [];
    // books — full same-rank groups of size >= 2
    const byRank = new Map<number, Card[]>();
    for (const c of cs) {
      const g = byRank.get(c.rank);
      if (g) g.push(c);
      else byRank.set(c.rank, [c]);
    }
    for (const g of byRank.values()) if (g.length >= 2) melds.push(g);
    // runs — per suit, maximal consecutive chains on the circle A..K..A
    for (let suit = 0; suit < 4; suit++) {
      const inSuit = cs.filter((c) => c.suit === suit);
      const present = new Set(inSuit.map((c) => c.rank));
      const firstOf = new Map<number, Card>();
      for (const c of inSuit) if (!firstOf.has(c.rank)) firstOf.set(c.rank, c);
      const distinct = [...present];
      if (distinct.length === 13) {
        const run: Card[] = [];
        for (let r = 1; r <= 13; r++) run.push(firstOf.get(r) as Card);
        melds.push(run);
      } else if (distinct.length >= 2) {
        for (const r of distinct) {
          const pred = r === 1 ? 13 : r - 1;
          if (present.has(pred)) continue; // not a run start
          const run: Card[] = [];
          let cur = r;
          while (present.has(cur)) {
            run.push(firstOf.get(cur) as Card);
            cur = cur === 13 ? 1 : cur + 1;
          }
          if (run.length >= 2) melds.push(run);
        }
      }
    }
    return melds as CSValue[];
  });
  pure("valueOf", (args) => {
    const c = args[0];
    if (c instanceof Card) return c.value;
    throw new RuntimeError("valueOf: expected a card");
  });
  pure("handValue", (args) => asCardList(args[0], "handValue").reduce((s, c) => s + c.value, 0));
  def("playersWithMax", function* (args) {
    return yield* playersExtreme(args[0], 1);
  });
  def("playersWithMin", function* (args) {
    return yield* playersExtreme(args[0], -1);
  });

  // =====================================================================
  // Decisions (yield ChoiceRequest)
  // =====================================================================
  // The single decision primitive: the acting player picks one of `options`.
  // Any displayable value may be an option — a card, a player, a number, a bool,
  // a list (e.g. a meld), a string, a `labeled(...)` value, or `null` (which the
  // UI offers as a "None"/decline button). Returns the chosen option, with any
  // `labeled` wrapper stripped, so game code sees the underlying value.
  def("choose", function* (args) {
    const who = asPlayer(args[0], "choose");
    const options = asList(args[1], "choose");
    const prompt = args.length > 2 ? String(args[2]) : "";
    const req: ChoiceRequest = { player: who, prompt, options };
    const answer = (yield req) as CSValue;
    if (!options.some((o) => sameValue(o, answer))) {
      throw new RuntimeError(`controller chose an illegal option: ${display(answer)}`);
    }
    return unwrap(answer);
  });
  // Pair a value with a display string for a `choose` option. `choose` returns
  // the underlying value, so e.g. `labeled(r, rankName(r))` lets a rank choice
  // show "Jack" while still returning the number 11.
  pure("labeled", (args) => new Labeled(args[0], String(args[1])));

  // =====================================================================
  // Misc
  // =====================================================================
  pure("log", (args) => {
    if (state.globals.get("__quiet") !== true) {
      // eslint-disable-next-line no-console
      console.log("[game]", ...args.map(display));
    }
    return null;
  });
  // player-facing narration (round results, eliminations, …). Routed to the
  // host's onEvent sink if present (the web move log), else printed by the CLI.
  pure("announce", (args) => {
    const msg = args.map(display).join(" ");
    if (state.onAnnounce) state.onAnnounce(msg);
    else if (state.globals.get("__quiet") !== true) console.log("»", msg);
    return null;
  });
  pure("rng", () => state.rng.next());
  pure("abs", (args) => Math.abs(num(args[0])));
  pure("floor", (args) => Math.floor(num(args[0])));
  pure("ceil", (args) => Math.ceil(num(args[0])));
  pure("round", (args) => Math.round(num(args[0])));

  // ---- shared generator helpers that close over `reg` data ----
  function* extreme(args: CSValue[], who: string, dir: number): Eval<CSValue> {
    const list = asList(args[0], who);
    if (list.length === 0) return null;
    let best = list[0];
    let bestKey = yield* keyNum(args[1], best);
    for (let i = 1; i < list.length; i++) {
      const k = yield* keyNum(args[1], list[i]);
      if (dir > 0 ? k > bestKey : k < bestKey) {
        best = list[i];
        bestKey = k;
      }
    }
    return best;
  }
  function* reduceMinMax(args: CSValue[], dir: number): Eval<CSValue> {
    if (args.length === 1 && isList(args[0])) {
      const list = args[0];
      if (list.length === 0) return null;
      let best = num(list[0]);
      for (const x of list) best = dir > 0 ? Math.max(best, num(x)) : Math.min(best, num(x));
      return best;
    }
    if (args.length >= 2 && isList(args[0]) && isCallable(args[1])) {
      return yield* extreme(args, dir > 0 ? "max" : "min", dir);
    }
    // numeric over scalar args
    const nums = args.map(num);
    return dir > 0 ? Math.max(...nums) : Math.min(...nums);
  }
  function* playersExtreme(keyFn: CSValue, dir: number): Eval<CSValue> {
    const ps = state.activePlayers();
    const scored: { p: Player; k: number }[] = [];
    for (const p of ps) scored.push({ p, k: yield* keyNum(keyFn, p) });
    if (scored.length === 0) return [];
    let best = scored[0].k;
    for (const s of scored) best = dir > 0 ? Math.max(best, s.k) : Math.min(best, s.k);
    return scored.filter((s) => s.k === best).map((s) => s.p);
  }

  return reg;
}

// ---- module-level pure helpers ----
function num(v: CSValue): number {
  if (typeof v !== "number") throw new RuntimeError(`expected a number, got ${typeName(v)}`);
  return v;
}
function sameValue(a: CSValue, b: CSValue): boolean {
  a = unwrap(a);
  b = unwrap(b);
  if (a === b) return true;
  if (a instanceof Card && b instanceof Card) return a.id === b.id;
  if (a instanceof Player && b instanceof Player) return a.id === b.id;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  return false;
}
function toRanks(v: CSValue): number[] {
  if (!isList(v)) throw new RuntimeError(`expected a list, got ${typeName(v)}`);
  return v.map((x) => {
    if (x instanceof Card) return x.rank;
    if (typeof x === "number") return x;
    throw new RuntimeError(`isRun: expected cards or rank numbers, got ${typeName(x)}`);
  });
}
function uniqueSortedNums(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}
function isRunOfRanks(ranks: number[], wrap: boolean): boolean {
  if (ranks.length <= 1) return true;
  const sorted = [...new Set(ranks)].sort((a, b) => a - b);
  if (sorted.length !== ranks.length) return false; // duplicates can't be a run
  // try plain ascending
  let contiguous = true;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) contiguous = false;
  if (contiguous) return true;
  if (!wrap) return false;
  // wrapping at Ace: e.g. Q,K,A,2,3 -> ranks 12,13,1,2,3. Rotate so the gap
  // straddles 13->1. Build the circular sequence and check a contiguous window.
  const present = new Set(sorted);
  for (let start = 1; start <= 13; start++) {
    let ok = true;
    for (let i = 0; i < sorted.length; i++) {
      const r = ((start - 1 + i) % 13) + 1;
      if (!present.has(r)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
