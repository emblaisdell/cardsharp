"""Evaluation: head-to-head and vs-random win rates, with seat-orientation
rotation to cancel turn-order bias (mirrors packages/ml/h2h.mjs)."""

import random
import numpy as np

from .selfplay import play_episode


class RandomAgent:
    def __init__(self, seed=0):
        self.rng = random.Random(seed)

    def choose_index(self, seat, obs, options, req):
        return self.rng.randrange(len(options))


def _play(program, num_players, seed, agents, max_decisions=4000):
    """agents: list of policy objects (one per seat). Returns winner id set.
    Long games are capped (resolved by score) to bound benchmark wall-clock."""
    def choose_index(seat, obs, options, req):
        return agents[seat].choose_index(seat, obs, options, req)
    winners, scores, ndec = play_episode(program, num_players, seed, choose_index,
                                         max_decisions=max_decisions)
    return winners


def eval_vs_random(program, num_players, agent, games=100, base_seed=1000,
                   max_decisions=4000):
    """`agent` occupies each seat in turn; all other seats are random. Returns the
    agent's win fraction (counting shared wins as a win)."""
    wins = 0
    n = 0
    for orient in range(num_players):
        for i in range(games):
            seed = base_seed + i * 13 + orient * 7919
            agents = []
            for s in range(num_players):
                if s == orient:
                    agents.append(agent)
                else:
                    agents.append(RandomAgent(seed ^ (s * 131 + 7)))
            w = _play(program, num_players, seed, agents, max_decisions)
            if orient in w:
                wins += 1
            n += 1
    return wins / max(1, n)


def match(program, num_players, agent_a, agent_b, games=100, base_seed=2000,
          max_decisions=4000):
    """agent_a takes one seat, agent_b the rest; rotate which seat A occupies.
    Returns (a_winrate, b_winrate). Remaining (3rd+) seats also use B."""
    a_wins = 0
    b_wins = 0
    n = 0
    for a_seat in range(num_players):
        for i in range(games):
            seed = base_seed + i * 13 + a_seat * 7919
            agents = []
            for s in range(num_players):
                agents.append(agent_a if s == a_seat else agent_b)
            w = _play(program, num_players, seed, agents, max_decisions)
            if a_seat in w:
                a_wins += 1
            if any(s in w for s in range(num_players) if s != a_seat):
                b_wins += 1
            n += 1
    return a_wins / max(1, n), b_wins / max(1, n)
