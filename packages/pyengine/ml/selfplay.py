"""Episode runner for self-play / evaluation. The interpreter is synchronous, so
a policy is just the `decide` callback: at each decision we hand the policy the
acting seat's masked observation + legal options and it returns an index.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cardsharp.state import GameState  # noqa: E402
from cardsharp.interp import Interpreter, GameOver  # noqa: E402


class _Cap(GameOver):
    pass


def play_episode(program, num_players, seed, choose_index, names=None,
                 max_decisions=20000):
    """Run one game. `choose_index(seat, obs, options, req) -> int`.

    Returns (winner_ids:set, scores:list, n_decisions:int). A runaway game is
    cut off after `max_decisions` and resolved by score (safety valve)."""
    state = GameState(num_players, seed, names)
    state.globals["__quiet"] = True
    counter = [0]

    def decide(req):
        counter[0] += 1
        if counter[0] > max_decisions:
            raise _Cap()
        obs = state.observe(req.player)
        idx = choose_index(req.player.id, obs, req.options, req)
        return req.options[idx]

    interp = Interpreter(program, state, decide)
    winners = interp.run()
    scores = [interp.score_of(p) for p in state.players]
    winner_ids = set(p.id for p in winners)
    return winner_ids, scores, counter[0]
