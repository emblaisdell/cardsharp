"""Sanity tests for the Python ♠# port. Run:  python test_engine.py

  * RNG matches the documented mulberry32 stream.
  * Every game parses and runs to completion with a random controller.
  * Cross-engine equivalence is covered separately by crossval.sh (diffs the full
    decision trace against the TS engine).
"""

import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cardsharp import RNG, parse, GameState  # noqa: E402
from cardsharp.interp import Interpreter  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GAMES = {
    "gofish": [2, 3, 4], "oldmaid": [3, 4], "blackjack": [2, 3],
    "thirtyone": [2, 3, 4], "crazybridge": [3, 4], "moneymoneymoney": [3],
    "tableless": [2, 4], "thewall": [2, 3],
}


def test_rng():
    r = RNG(12345)
    xs = [r.next() for _ in range(3)]
    assert abs(xs[0] - 0.9797282677609473) < 1e-15, xs
    assert abs(xs[1] - 0.3067522644996643) < 1e-15, xs
    print("ok   rng stream")


def run_random(game, np_, seed):
    src = open(os.path.join(ROOT, "games", f"{game}.card")).read()
    program = parse(src)
    state = GameState(np_, seed)
    state.globals["__quiet"] = True
    rng = random.Random(seed * 31 + 1)

    def decide(req):
        return req.options[rng.randrange(len(req.options))]

    winners = Interpreter(program, state, decide).run()
    return winners


def test_games():
    for game, seats in GAMES.items():
        for np_ in seats:
            for seed in (1, 2, 3, 99):
                w = run_random(game, np_, seed)
                assert isinstance(w, list), (game, np_, seed)
            print(f"ok   {game} {seats}")


if __name__ == "__main__":
    test_rng()
    test_games()
    print("\nALL PASS")
