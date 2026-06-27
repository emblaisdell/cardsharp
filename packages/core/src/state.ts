// Game state: players, zones (piles), globals, RNG, and visibility-aware
// observations.

import { Card, Pile, Player, CSRecord } from "./values.ts";
import type { CSValue, ZoneDef, ZoneHandle } from "./values.ts";
import { RNG } from "./rng.ts";

// deep-clone a game-global value, remapping player references to the clone's
// players. Cards are shared (identity by id). Zone handles / callables aren't
// stored in game globals by any current game, so they're shared as-is.
function cloneValue(v: CSValue, pmap: Map<number, Player>): CSValue {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Card) return v;
  if (v instanceof Player) return pmap.get(v.id) ?? v;
  if (Array.isArray(v)) return v.map((x) => cloneValue(x, pmap));
  if (v instanceof CSRecord) {
    const r = new CSRecord();
    for (const [k, val] of v.map) r.set(k, cloneValue(val, pmap));
    return r;
  }
  return v;
}

export class GameState {
  players: Player[];
  rng: RNG;

  zoneDefs = new Map<string, ZoneDef>();
  sharedPiles = new Map<string, Pile>();
  perPlayerPiles = new Map<string, Pile[]>();

  current: Player;
  ended = false;
  declaredWinners: Player[] | null = null;
  turnCount = 0;
  private nextCardId = 1;

  // game-global variables (var declarations at game scope, plus engine vars)
  globals = new Map<string, CSValue>();

  // optional host sink for announce() narration (UI move log, CLI, etc.)
  onAnnounce: ((msg: string) => void) | null = null;

  constructor(numPlayers: number, seed: number, names?: string[]) {
    this.players = [];
    for (let i = 0; i < numPlayers; i++) {
      this.players.push(new Player(i, names?.[i] ?? `P${i + 1}`));
    }
    this.rng = new RNG(seed);
    this.current = this.players[0];
  }

  // ---- zones ----
  defineZone(def: ZoneDef): void {
    this.zoneDefs.set(def.name, def);
    if (def.perPlayer) {
      this.perPlayerPiles.set(def.name, this.players.map((p) => new Pile(def, p)));
    } else {
      this.sharedPiles.set(def.name, new Pile(def, null));
    }
  }

  zoneHandle(name: string): ZoneHandle | null {
    const def = this.zoneDefs.get(name);
    if (!def) return null;
    if (def.perPlayer) {
      return { zone: "family", def, piles: this.perPlayerPiles.get(name) as Pile[] };
    }
    return { zone: "pile", pile: this.sharedPiles.get(name) as Pile };
  }

  pileOf(name: string, player?: Player): Pile | null {
    const def = this.zoneDefs.get(name);
    if (!def) return null;
    if (def.perPlayer) {
      if (!player) return null;
      return (this.perPlayerPiles.get(name) as Pile[])[player.id];
    }
    return this.sharedPiles.get(name) as Pile;
  }

  // ---- cloning (for snapshot / search / determinization) ----
  // A deep, independent copy: players and piles are fresh objects, Card objects
  // are shared (immutable identity — `id` equality must hold across the clone),
  // and game globals are deep-cloned with player references remapped. zoneDefs
  // are immutable and shared. The clone is silent (onAnnounce = null).
  clone(): GameState {
    const c = new GameState(this.players.length, 0);
    c.players = this.players.map((p) => {
      const np = new Player(p.id, p.name);
      np.eliminated = p.eliminated;
      return np;
    });
    const pmap = new Map(c.players.map((p) => [p.id, p]));

    c.zoneDefs = this.zoneDefs; // immutable
    c.sharedPiles = new Map();
    for (const [name, pile] of this.sharedPiles) {
      const np = new Pile(pile.def, null);
      np.cards = pile.cards.slice();
      c.sharedPiles.set(name, np);
    }
    c.perPlayerPiles = new Map();
    for (const [name, piles] of this.perPlayerPiles) {
      c.perPlayerPiles.set(
        name,
        piles.map((pile) => {
          const np = new Pile(pile.def, pile.owner ? (pmap.get(pile.owner.id) as Player) : null);
          np.cards = pile.cards.slice();
          return np;
        }),
      );
    }

    c.current = pmap.get(this.current.id) as Player;
    c.ended = this.ended;
    c.declaredWinners = this.declaredWinners
      ? this.declaredWinners.map((p) => pmap.get(p.id) as Player)
      : null;
    c.turnCount = this.turnCount;
    c.nextCardId = this.nextCardId;
    c.rng = this.rng.clone();
    c.globals = new Map();
    for (const [k, v] of this.globals) c.globals.set(k, cloneValue(v, pmap));
    c.onAnnounce = null;
    return c;
  }

  private canSeePile(pile: Pile, viewerId: number): boolean {
    switch (pile.def.visibility) {
      case "up":
        return true;
      case "down":
        return false;
      case "owner":
        return pile.owner?.id === viewerId;
    }
  }

  // A determinization for `viewer`: a clone in which every card the viewer can
  // NOT see is randomly re-dealt among the hidden slots (counts and visible
  // cards preserved). This is the fair input to information-set search — the
  // searcher reasons over plausible worlds consistent with its observation, and
  // never sees the true hidden layout or the game seed. Sampling uses `rng`
  // (a fresh, search-local RNG — not the game's).
  determinize(viewer: Player, rng: RNG): GameState {
    const c = this.clone();
    const hiddenPiles: Pile[] = [];
    const pool: Card[] = [];
    const collect = (pile: Pile): void => {
      if (!c.canSeePile(pile, viewer.id)) {
        hiddenPiles.push(pile);
        for (const card of pile.cards) pool.push(card);
      }
    };
    for (const pile of c.sharedPiles.values()) collect(pile);
    for (const piles of c.perPlayerPiles.values()) for (const pile of piles) collect(pile);

    rng.shuffle(pool);
    let i = 0;
    for (const pile of hiddenPiles) {
      for (let k = 0; k < pile.cards.length; k++) pile.cards[k] = pool[i++];
    }
    return c;
  }

  // ---- deck ----
  buildStandard52(into: Pile): void {
    for (let suit = 0; suit < 4; suit++) {
      for (let rank = 1; rank <= 13; rank++) {
        into.cards.push(new Card(rank, suit, rank, this.nextCardId++));
      }
    }
  }

  // ---- players / turns ----
  activePlayers(): Player[] {
    return this.players.filter((p) => !p.eliminated);
  }
  nextActiveAfter(p: Player): Player {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const cand = this.players[(p.id + k) % n];
      if (!cand.eliminated) return cand;
    }
    return p;
  }

  // ---- visibility-aware observation (for networking / ML) ----
  // Returns a plain JSON-able snapshot from `viewer`'s perspective. Cards in
  // zones the viewer may not see are replaced by `null` placeholders, so the
  // count is known but identities are hidden.
  observe(viewer: Player): Observation {
    const zones: Record<string, ZoneView | ZoneView[]> = {};
    for (const [name, def] of this.zoneDefs) {
      if (def.perPlayer) {
        zones[name] = (this.perPlayerPiles.get(name) as Pile[]).map((pile) =>
          this.viewPile(pile, viewer),
        );
      } else {
        zones[name] = this.viewPile(this.sharedPiles.get(name) as Pile, viewer);
      }
    }
    return {
      viewer: viewer.id,
      current: this.current.id,
      players: this.players.map((p) => ({ id: p.id, name: p.name, out: p.eliminated })),
      zones,
      turn: this.turnCount,
    };
  }

  private canSee(pile: Pile, viewer: Player): boolean {
    switch (pile.def.visibility) {
      case "up":
        return true;
      case "down":
        return false;
      case "owner":
        return pile.owner?.id === viewer.id;
    }
  }

  private viewPile(pile: Pile, viewer: Player): ZoneView {
    const visible = this.canSee(pile, viewer);
    return {
      size: pile.cards.length,
      owner: pile.owner ? pile.owner.id : null,
      layout: pile.def.layout,
      cards: pile.cards.map((c) =>
        visible ? { rank: c.rank, suit: c.suit, value: c.value, id: c.id } : null,
      ),
    };
  }
}

export interface ZoneView {
  size: number;
  owner: number | null;
  layout: "pile" | "hand";
  cards: ({ rank: number; suit: number; value: number; id: number } | null)[];
}

export interface Observation {
  viewer: number;
  current: number;
  players: { id: number; name: string; out: boolean }[];
  zones: Record<string, ZoneView | ZoneView[]>;
  turn: number;
}
