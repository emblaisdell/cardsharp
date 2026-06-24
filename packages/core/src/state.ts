// Game state: players, zones (piles), globals, RNG, and visibility-aware
// observations.

import { Card, Pile, Player } from "./values.ts";
import type { CSValue, ZoneDef, ZoneHandle } from "./values.ts";
import { RNG } from "./rng.ts";

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
