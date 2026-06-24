// The Card# type system.
//
// Card# is gradually typed: expressions whose type is known are checked
// strictly, while `any` (unknowable statically — e.g. an untyped function
// parameter) is compatible with everything. This catches real mistakes
// (calling a non-function, `current.rank`, `size(5)`, arithmetic on a list)
// before the game runs, without forcing annotations everywhere.

export type Type =
  | { k: "num" }
  | { k: "bool" }
  | { k: "str" }
  | { k: "null" }
  | { k: "any" }
  | { k: "void" }
  | { k: "card" }
  | { k: "player" }
  | { k: "pile" } // a concrete zone pile
  | { k: "family" } // a per-player zone (must be indexed)
  | { k: "record" }
  | { k: "cardish" } // accepts a card or a list of cards (move/moveTo input)
  | { k: "list"; el: Type }
  | { k: "fun"; params: Type[]; required: number; rest: Type | null; ret: Type };

export const T = {
  num: { k: "num" } as Type,
  bool: { k: "bool" } as Type,
  str: { k: "str" } as Type,
  null: { k: "null" } as Type,
  any: { k: "any" } as Type,
  void: { k: "void" } as Type,
  card: { k: "card" } as Type,
  player: { k: "player" } as Type,
  pile: { k: "pile" } as Type,
  family: { k: "family" } as Type,
  record: { k: "record" } as Type,
  cardish: { k: "cardish" } as Type,
  list: (el: Type): Type => ({ k: "list", el }),
  fun: (params: Type[], ret: Type, required = params.length, rest: Type | null = null): Type => ({
    k: "fun",
    params,
    required,
    rest,
    ret,
  }),
};

export function show(t: Type): string {
  switch (t.k) {
    case "list":
      return `list<${show(t.el)}>`;
    case "fun":
      return `fn(${t.params.map(show).join(", ")}) -> ${show(t.ret)}`;
    case "cardish":
      return "card|list<card>";
    default:
      return t.k;
  }
}

// Is a value of type `a` acceptable where `b` is expected?
export function assignable(a: Type, b: Type): boolean {
  if (a.k === "any" || b.k === "any") return true;
  if (a.k === "null") return true; // null fits anywhere (absence)
  if (b.k === "cardish") {
    return a.k === "card" || (a.k === "list" && (a.el.k === "card" || a.el.k === "any"));
  }
  if (b.k === "num" && a.k === "num") return true;
  if (b.k === "list" && a.k === "list") return assignable(a.el, b.el);
  if (b.k === "fun" && a.k === "fun") return true; // arity/shape checked at the call site
  return a.k === b.k;
}
