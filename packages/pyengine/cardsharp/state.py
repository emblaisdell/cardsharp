"""Game state: players, zones (piles), globals, RNG, visibility-aware
observations. Port of packages/core/src/state.ts."""

from .values import Card, Pile, Player, ZoneDef, ZoneHandle, CSRecord
from .rng import RNG


def _clone_value(v, pmap):
    if v is None or not isinstance(v, (Card, Player, list, CSRecord)):
        return v
    if isinstance(v, Card):
        return v
    if isinstance(v, Player):
        return pmap.get(v.id, v)
    if isinstance(v, list):
        return [_clone_value(x, pmap) for x in v]
    if isinstance(v, CSRecord):
        r = CSRecord()
        for k, val in v.map.items():
            r.set(k, _clone_value(val, pmap))
        return r
    return v


class GameState:
    def __init__(self, num_players, seed, names=None):
        self.players = [Player(i, (names[i] if names and i < len(names) else f"P{i + 1}"))
                        for i in range(num_players)]
        self.rng = RNG(seed)
        self.zone_defs = {}        # name -> ZoneDef
        self.shared_piles = {}     # name -> Pile
        self.per_player_piles = {}  # name -> [Pile]
        self.current = self.players[0]
        self.ended = False
        self.declared_winners = None
        self.turn_count = 0
        self._next_card_id = 1
        self.globals = {}
        self.on_announce = None

    # ---- zones ----
    def define_zone(self, zdef):
        self.zone_defs[zdef.name] = zdef
        if zdef.perPlayer:
            self.per_player_piles[zdef.name] = [Pile(zdef, p) for p in self.players]
        else:
            self.shared_piles[zdef.name] = Pile(zdef, None)

    def zone_handle(self, name):
        zdef = self.zone_defs.get(name)
        if not zdef:
            return None
        if zdef.perPlayer:
            return ZoneHandle("family", zdef=zdef, piles=self.per_player_piles[name])
        return ZoneHandle("pile", pile=self.shared_piles[name])

    def pile_of(self, name, player=None):
        zdef = self.zone_defs.get(name)
        if not zdef:
            return None
        if zdef.perPlayer:
            if player is None:
                return None
            return self.per_player_piles[name][player.id]
        return self.shared_piles[name]

    # ---- cloning ----
    def clone(self):
        c = GameState(len(self.players), 0)
        c.players = []
        for p in self.players:
            np = Player(p.id, p.name)
            np.eliminated = p.eliminated
            c.players.append(np)
        pmap = {p.id: p for p in c.players}

        c.zone_defs = self.zone_defs  # immutable
        c.shared_piles = {}
        for name, pile in self.shared_piles.items():
            np = Pile(pile.zdef, None)
            np.cards = list(pile.cards)
            c.shared_piles[name] = np
        c.per_player_piles = {}
        for name, piles in self.per_player_piles.items():
            newpiles = []
            for pile in piles:
                owner = pmap.get(pile.owner.id) if pile.owner else None
                np = Pile(pile.zdef, owner)
                np.cards = list(pile.cards)
                newpiles.append(np)
            c.per_player_piles[name] = newpiles

        c.current = pmap[self.current.id]
        c.ended = self.ended
        c.declared_winners = ([pmap[p.id] for p in self.declared_winners]
                              if self.declared_winners is not None else None)
        c.turn_count = self.turn_count
        c._next_card_id = self._next_card_id
        c.rng = self.rng.clone()
        c.globals = {k: _clone_value(v, pmap) for k, v in self.globals.items()}
        c.on_announce = None
        return c

    def _can_see_pile(self, pile, viewer_id):
        vis = pile.zdef.visibility
        if vis == "up":
            return True
        if vis == "down":
            return False
        return pile.owner is not None and pile.owner.id == viewer_id

    def determinize(self, viewer, rng):
        c = self.clone()
        hidden = []
        pool = []
        for pile in c.shared_piles.values():
            if not c._can_see_pile(pile, viewer.id):
                hidden.append(pile)
                pool.extend(pile.cards)
        for piles in c.per_player_piles.values():
            for pile in piles:
                if not c._can_see_pile(pile, viewer.id):
                    hidden.append(pile)
                    pool.extend(pile.cards)
        rng.shuffle(pool)
        i = 0
        for pile in hidden:
            for k in range(len(pile.cards)):
                pile.cards[k] = pool[i]
                i += 1
        return c

    def determinize_in_place(self, viewer, rng):
        """Reshuffle the cards the viewer cannot see, mutating the existing pile
        arrays. Used to determinize a cloned Machine whose frames already
        reference these pile objects."""
        hidden = []
        pool = []
        for pile in self.shared_piles.values():
            if not self._can_see_pile(pile, viewer.id):
                hidden.append(pile)
                pool.extend(pile.cards)
        for piles in self.per_player_piles.values():
            for pile in piles:
                if not self._can_see_pile(pile, viewer.id):
                    hidden.append(pile)
                    pool.extend(pile.cards)
        rng.shuffle(pool)
        i = 0
        for pile in hidden:
            for k in range(len(pile.cards)):
                pile.cards[k] = pool[i]
                i += 1

    # ---- deck ----
    def build_standard52(self, into):
        for suit in range(4):
            for rank in range(1, 14):
                into.cards.append(Card(rank, suit, rank, self._next_card_id))
                self._next_card_id += 1

    # ---- players / turns ----
    def active_players(self):
        return [p for p in self.players if not p.eliminated]

    def next_active_after(self, p):
        n = len(self.players)
        for k in range(1, n + 1):
            cand = self.players[(p.id + k) % n]
            if not cand.eliminated:
                return cand
        return p

    # ---- observation ----
    def observe(self, viewer):
        zones = {}
        for name, zdef in self.zone_defs.items():
            if zdef.perPlayer:
                zones[name] = [self._view_pile(pile, viewer)
                               for pile in self.per_player_piles[name]]
            else:
                zones[name] = self._view_pile(self.shared_piles[name], viewer)
        return {
            "viewer": viewer.id,
            "current": self.current.id,
            "players": [{"id": p.id, "name": p.name, "out": p.eliminated}
                        for p in self.players],
            "zones": zones,
            "turn": self.turn_count,
        }

    def _view_pile(self, pile, viewer):
        visible = self._can_see_pile(pile, viewer.id)
        return {
            "size": len(pile.cards),
            "owner": pile.owner.id if pile.owner else None,
            "layout": pile.zdef.layout,
            "cards": [({"rank": c.rank, "suit": c.suit, "value": c.value, "id": c.id}
                       if visible else None) for c in pile.cards],
        }
