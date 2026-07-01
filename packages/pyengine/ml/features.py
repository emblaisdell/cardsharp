"""Feature extraction for the Python ML players.

Two encodings share one observation:
  * `featurize_options` — the *exact* 26-d generic per-option features used by the
    TS linear policy (packages/ml/src/features.ts), so we can load and play the
    trained linear JSON models for head-to-head evaluation.
  * `state_features` — a richer, permutation-invariant card-matrix state vector
    (4x13 multisets per region + scalars) for the neural encoder.

Both read only the generic, visibility-masked observation, so one architecture
works across every ♠# game.
"""

import numpy as np

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cardsharp.values import Card, Player, unwrap  # noqa: E402

# ---------- generic per-option features (TS-compatible, DIM=26) ----------
VALUE_KINDS = ["player", "card", "list", "number", "boolean", "string", "none", "other"]

FEATURE_NAMES = (
    [f"vk:{k}" for k in VALUE_KINDS]
    + ["card:rank", "card:value", "card:isAce", "card:isFace",
       "card:suitC", "card:suitD", "card:suitH", "card:suitS"]
    + ["player:visibleCards", "player:active"]
    + ["scalar:num", "scalar:bool"]
    + ["ctx:myHandSize", "ctx:myHandValue", "ctx:numOptions", "ctx:turn", "ctx:numActive"]
    + ["bias"]
)
DIM = len(FEATURE_NAMES)


def _value_kind(option):
    if option is None:
        return "none"
    if isinstance(option, Card):
        return "card"
    if isinstance(option, Player):
        return "player"
    if isinstance(option, list):
        return "list"
    if isinstance(option, bool):
        return "boolean"
    if isinstance(option, (int, float)):
        return "number"
    if isinstance(option, str):
        return "string"
    return "other"


def _context(obs, num_options):
    my_hand_size = 0
    my_hand_value = 0
    viewer = obs["viewer"]
    for v in obs["zones"].values():
        piles = v if isinstance(v, list) else [v]
        for pile in piles:
            if pile["owner"] != viewer:
                continue
            for c in pile["cards"]:
                if c:
                    my_hand_size += 1
                    my_hand_value += c["value"]
    num_active = sum(1 for p in obs["players"] if not p["out"])
    return {
        "myHandSize": my_hand_size,
        "myHandValue": my_hand_value,
        "numOptions": num_options,
        "turn": obs["turn"],
        "numActive": num_active,
    }


def _visible_cards_of(obs, player_id):
    n = 0
    for v in obs["zones"].values():
        piles = v if isinstance(v, list) else [v]
        for pile in piles:
            if pile["owner"] == player_id:
                n += pile["size"]
    return n


def featurize_option(raw_option, ctx, obs):
    option = unwrap(raw_option)
    f = [0.0] * DIM
    i = 0
    ki = VALUE_KINDS.index(_value_kind(option))
    f[i + ki] = 1.0
    i += len(VALUE_KINDS)
    if isinstance(option, Card):
        f[i + 0] = option.rank / 13
        f[i + 1] = option.value / 14
        f[i + 2] = 1.0 if option.rank == 1 else 0.0
        f[i + 3] = 1.0 if option.rank >= 11 else 0.0
        f[i + 4 + option.suit] = 1.0
    i += 8
    if isinstance(option, Player):
        f[i + 0] = _visible_cards_of(obs, option.id) / 20
        f[i + 1] = 0.0 if option.eliminated else 1.0
    i += 2
    if isinstance(option, bool):
        f[i + 1] = 1.0 if option else 0.0
    elif isinstance(option, (int, float)):
        f[i + 0] = option / 13
    i += 2
    f[i + 0] = ctx["myHandSize"] / 20
    f[i + 1] = ctx["myHandValue"] / 60
    f[i + 2] = ctx["numOptions"] / 10
    f[i + 3] = ctx["turn"] / 50
    f[i + 4] = ctx["numActive"] / 6
    i += 5
    f[i] = 1.0  # bias
    return f


def featurize_options(options, obs):
    ctx = _context(obs, len(options))
    return [featurize_option(o, ctx, obs) for o in options]


# ---------- card-matrix state features (for the neural encoder) ----------
# Layout: my_cards (52) | visible_cards (52) | per-seat visible counts (MAX_SEATS)
#       | scalars (7).  MAX_SEATS caps the relative-seat one-hotish counts.
MAX_SEATS = 6
STATE_DIM = 52 + 52 + MAX_SEATS + 7


def _mat_index(rank, suit):
    return suit * 13 + (rank - 1)


def state_features(obs):
    viewer = obs["viewer"]
    my = np.zeros(52, dtype=np.float32)
    vis = np.zeros(52, dtype=np.float32)
    seat_counts = np.zeros(MAX_SEATS, dtype=np.float32)
    my_hand_size = 0
    my_hand_value = 0
    for v in obs["zones"].values():
        piles = v if isinstance(v, list) else [v]
        for pile in piles:
            owner = pile["owner"]
            if owner is not None and 0 <= owner < MAX_SEATS:
                seat_counts[owner] += pile["size"]
            for c in pile["cards"]:
                if c:
                    idx = _mat_index(c["rank"], c["suit"])
                    vis[idx] += 1.0
                    if owner == viewer:
                        my[idx] += 1.0
                        my_hand_size += 1
                        my_hand_value += c["value"]
    num_active = sum(1 for p in obs["players"] if not p["out"])
    num_players = len(obs["players"])
    scalars = np.array([
        my_hand_size / 20.0,
        my_hand_value / 60.0,
        obs["turn"] / 50.0,
        num_active / 6.0,
        num_players / 6.0,
        viewer / 6.0,
        obs["current"] / 6.0,
    ], dtype=np.float32)
    # relative seat counts (shift so viewer is index 0) normalized
    rel = np.zeros(MAX_SEATS, dtype=np.float32)
    for s in range(MAX_SEATS):
        rel[s] = seat_counts[(viewer + s) % MAX_SEATS] / 20.0
    return np.concatenate([my / 4.0, vis / 4.0, rel, scalars]).astype(np.float32)


# option feature dim used by the neural action-scorer (reuse the generic 26-d)
OPTION_DIM = DIM
