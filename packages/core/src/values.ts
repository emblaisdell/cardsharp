// Runtime value types for Card#.
//
// Card# values map onto JS values where natural (number, boolean, string, null,
// arrays for lists) and onto small classes for the domain types (Card, Player,
// Pile/zone handles) and callables.

export type CSValue =
  | number
  | boolean
  | string
  | null
  | Card
  | Player
  | ZoneHandle
  | Callable
  | CSRecord
  | CSValue[];

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export const SUIT_NAMES = ["Clubs", "Diamonds", "Hearts", "Spades"] as const;
export const RANK_NAMES = [
  "", "Ace", "2", "3", "4", "5", "6", "7", "8", "9", "10", "Jack", "Queen", "King",
] as const;

export class Card {
  readonly rank: number; // 1..13  (1=Ace, 11=J, 12=Q, 13=K)
  readonly suit: number; // 0..3   (0=Clubs, 1=Diamonds, 2=Hearts, 3=Spades)
  value: number; // numeric value used by the game (defaults to rank)
  readonly id: number; // stable hidden identity

  constructor(rank: number, suit: number, value: number, id: number) {
    this.rank = rank;
    this.suit = suit;
    this.value = value;
    this.id = id;
  }

  get color(): string {
    return this.suit === 1 || this.suit === 2 ? "red" : "black";
  }
  get rankName(): string {
    return RANK_NAMES[this.rank] ?? String(this.rank);
  }
  get suitName(): string {
    return SUIT_NAMES[this.suit] ?? String(this.suit);
  }
  get glyph(): string {
    return ["♣", "♦", "♥", "♠"][this.suit] ?? "?";
  }
  get label(): string {
    const r = this.rank === 10 ? "10" : (RANK_NAMES[this.rank] ?? "?")[0];
    const s = ["C", "D", "H", "S"][this.suit] ?? "?";
    return `${r}${s}`;
  }
  toString(): string {
    return this.label;
  }
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export class Player {
  readonly id: number; // 0-based seat index
  name: string;
  eliminated = false;

  constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }
  toString(): string {
    return this.name;
  }
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export type Visibility = "up" | "down" | "owner";

export interface ZoneDef {
  name: string;
  perPlayer: boolean;
  visibility: Visibility;
  layout: "pile" | "hand"; // rendering hint only; no effect on game logic
}

// A physical pile of cards. `order[0]` is the top.
export class Pile {
  readonly def: ZoneDef;
  readonly owner: Player | null; // owner for per-player zones, else null
  cards: Card[] = [];

  constructor(def: ZoneDef, owner: Player | null) {
    this.def = def;
    this.owner = owner;
  }
  get name(): string {
    return this.owner ? `${this.def.name}[${this.owner.name}]` : this.def.name;
  }
}

// A zone *value* as seen by game code. Either a concrete pile, or a per-player
// family that must be indexed by a player before use.
export type ZoneHandle =
  | { zone: "pile"; pile: Pile }
  | { zone: "family"; def: ZoneDef; piles: Pile[] };

export function isZoneHandle(v: CSValue): v is ZoneHandle {
  return v != null && typeof v === "object" && "zone" in (v as object);
}

// ---------------------------------------------------------------------------
// Records (rarely used map literals; e.g. groupBy results)
// ---------------------------------------------------------------------------

export class CSRecord {
  map = new Map<string, CSValue>();
  get(k: string): CSValue {
    return this.map.has(k) ? (this.map.get(k) as CSValue) : null;
  }
  set(k: string, v: CSValue): void {
    this.map.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// Callables
// ---------------------------------------------------------------------------

export interface Callable {
  call: true;
  name: string;
  // Implemented in interpreter.ts (user functions/lambdas) and builtins.ts.
  invoke: (args: CSValue[]) => Generator<unknown, CSValue, CSValue>;
}

export function isCallable(v: CSValue): v is Callable {
  return v != null && typeof v === "object" && (v as { call?: boolean }).call === true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isCard(v: CSValue): v is Card {
  return v instanceof Card;
}
export function isPlayer(v: CSValue): v is Player {
  return v instanceof Player;
}
export function isList(v: CSValue): v is CSValue[] {
  return Array.isArray(v);
}

export function truthy(v: CSValue): boolean {
  if (v === null || v === false) return false;
  if (v === 0) return false;
  if (v === "") return false;
  return true;
}

export function typeName(v: CSValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  if (v instanceof Card) return "card";
  if (v instanceof Player) return "player";
  if (v instanceof CSRecord) return "record";
  if (isZoneHandle(v)) return "zone";
  if (isCallable(v)) return "function";
  return typeof v;
}

export function display(v: CSValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map(display).join(", ") + "]";
  if (v instanceof Card) return v.label;
  if (v instanceof Player) return v.name;
  if (isZoneHandle(v)) return v.zone === "pile" ? v.pile.name : v.def.name + "[]";
  if (isCallable(v)) return `<fn ${v.name}>`;
  if (v instanceof CSRecord) {
    return "{" + [...v.map].map(([k, val]) => `${k}: ${display(val)}`).join(", ") + "}";
  }
  return String(v);
}
