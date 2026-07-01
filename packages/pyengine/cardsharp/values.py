"""Runtime value types for the Python ♠# interpreter.

Mirrors packages/core/src/values.ts. ♠# values map onto Python values where
natural (int/float, bool, str, None, list) and onto small classes for the domain
types (Card, Player, Pile, ZoneHandle, Labeled, Record) and callables.
"""

SUIT_NAMES = ["Clubs", "Diamonds", "Hearts", "Spades"]
RANK_NAMES = ["", "Ace", "2", "3", "4", "5", "6", "7", "8", "9", "10",
              "Jack", "Queen", "King"]
SUIT_GLYPHS = ["♣", "♦", "♥", "♠"]  # ♣ ♦ ♥ ♠


class Card:
    __slots__ = ("rank", "suit", "value", "id")

    def __init__(self, rank, suit, value, id):
        self.rank = rank
        self.suit = suit
        self.value = value
        self.id = id

    @property
    def color(self):
        return "red" if self.suit in (1, 2) else "black"

    @property
    def rankName(self):
        return RANK_NAMES[self.rank] if 0 <= self.rank < len(RANK_NAMES) else str(self.rank)

    @property
    def suitName(self):
        return SUIT_NAMES[self.suit] if 0 <= self.suit < 4 else str(self.suit)

    @property
    def glyph(self):
        return SUIT_GLYPHS[self.suit] if 0 <= self.suit < 4 else "?"

    @property
    def label(self):
        r = "10" if self.rank == 10 else (RANK_NAMES[self.rank] if 0 <= self.rank < len(RANK_NAMES) else "?")[0]
        s = ["C", "D", "H", "S"][self.suit] if 0 <= self.suit < 4 else "?"
        return f"{r}{s}"

    def __repr__(self):
        return self.label


class Player:
    __slots__ = ("id", "name", "eliminated")

    def __init__(self, id, name):
        self.id = id
        self.name = name
        self.eliminated = False

    def __repr__(self):
        return self.name


class ZoneDef:
    __slots__ = ("name", "perPlayer", "visibility", "layout")

    def __init__(self, name, perPlayer, visibility, layout):
        self.name = name
        self.perPlayer = perPlayer
        self.visibility = visibility  # "up" | "down" | "owner"
        self.layout = layout          # "pile" | "hand"


class Pile:
    __slots__ = ("zdef", "owner", "cards")

    def __init__(self, zdef, owner):
        self.zdef = zdef
        self.owner = owner
        self.cards = []

    @property
    def name(self):
        return f"{self.zdef.name}[{self.owner.name}]" if self.owner else self.zdef.name


class ZoneHandle:
    """Either a concrete pile (zone='pile') or a per-player family (zone='family')."""
    __slots__ = ("zone", "pile", "zdef", "piles")

    def __init__(self, zone, pile=None, zdef=None, piles=None):
        self.zone = zone
        self.pile = pile
        self.zdef = zdef
        self.piles = piles


class Labeled:
    __slots__ = ("value", "text")

    def __init__(self, value, text):
        self.value = value
        self.text = text

    def __repr__(self):
        return self.text


class CSRecord:
    __slots__ = ("map",)

    def __init__(self):
        self.map = {}

    def get(self, k):
        return self.map.get(k, None)

    def set(self, k, v):
        self.map[k] = v


class Callable:
    """Base for builtins and user functions/lambdas. invoke(args) runs synchronously."""
    call = True
    name = "fn"

    def invoke(self, args):
        raise NotImplementedError


class Builtin(Callable):
    __slots__ = ("name", "fn")

    def __init__(self, name, fn):
        self.name = name
        self.fn = fn

    def invoke(self, args):
        return self.fn(args)


# ---- helpers ----

def is_zone_handle(v):
    return isinstance(v, ZoneHandle)


def is_callable(v):
    return isinstance(v, Callable)


def is_card(v):
    return isinstance(v, Card)


def is_player(v):
    return isinstance(v, Player)


def is_list(v):
    return isinstance(v, list)


def is_labeled(v):
    return isinstance(v, Labeled)


def unwrap(v):
    while isinstance(v, Labeled):
        v = v.value
    return v


def truthy(v):
    if v is None or v is False:
        return False
    if v == 0 and isinstance(v, (int, float)) and not isinstance(v, bool):
        return False
    if v == "":
        return False
    return True


def type_name(v):
    if v is None:
        return "null"
    if isinstance(v, Labeled):
        return type_name(v.value)
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, list):
        return "list"
    if isinstance(v, Card):
        return "card"
    if isinstance(v, Player):
        return "player"
    if isinstance(v, CSRecord):
        return "record"
    if isinstance(v, ZoneHandle):
        return "zone"
    if isinstance(v, Callable):
        return "function"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    return type(v).__name__


def display(v):
    if v is None:
        return "None"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, Labeled):
        return v.text
    if isinstance(v, list):
        return "[" + ", ".join(display(x) for x in v) + "]"
    if isinstance(v, Card):
        return v.label
    if isinstance(v, Player):
        return v.name
    if isinstance(v, ZoneHandle):
        return v.pile.name if v.zone == "pile" else v.zdef.name + "[]"
    if isinstance(v, Callable):
        return f"<fn {v.name}>"
    if isinstance(v, CSRecord):
        return "{" + ", ".join(f"{k}: {display(val)}" for k, val in v.map.items()) + "}"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def same_value(a, b):
    a = unwrap(a)
    b = unwrap(b)
    if a is b:
        return True
    if isinstance(a, Card) and isinstance(b, Card):
        return a.id == b.id
    if isinstance(a, Player) and isinstance(b, Player):
        return a.id == b.id
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same_value(x, b[i]) for i, x in enumerate(a))
    # numeric / string / bool equality
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return a == b
