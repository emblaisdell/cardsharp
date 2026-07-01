"""Validate the resumable Machine: (1) it produces byte-identical games to the
synchronous interpreter, (2) clones are independent and continue correctly.

    python test_vm.py
"""
import os
import sys
import random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cardsharp import parse, GameState, display  # noqa: E402
from cardsharp.interp import Interpreter  # noqa: E402
from cardsharp.vm import Machine  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GAMES = {
    "gofish": [2, 3, 4], "oldmaid": [3, 4], "blackjack": [2, 3],
    "thirtyone": [2, 3, 4], "crazybridge": [3, 4], "moneymoneymoney": [3],
    "tableless": [2, 4], "thewall": [2, 3],
}


def src(game):
    return open(os.path.join(ROOT, "games", f"{game}.card")).read()


# A seeded-random policy: pick index by a fresh RNG(seed). If the two engines
# agree, they present the same options in the same order, so the index sequence —
# and the whole game — is identical. (Unlike "always option 0", random play also
# terminates the long money game normally.)
def interp_trace(program, np_, seed):
    state = GameState(np_, seed)
    state.globals["__quiet"] = True
    trace = []
    rng = random.Random(seed * 31 + 1)
    def decide(req):
        ans = req.options[rng.randrange(len(req.options))]
        trace.append(f"{req.player.id}:{display(ans)}")
        return ans
    winners = Interpreter(program, state, decide).run()
    return trace, [p.id for p in winners]


def machine_trace(program, np_, seed):
    state = GameState(np_, seed)
    state.globals["__quiet"] = True
    trace = []
    rng = random.Random(seed * 31 + 1)
    m = Machine(program, state, lambda req: req.options[0])
    r = m.start()
    guard = 0
    while not r.done:
        guard += 1
        if guard > 500000:
            raise RuntimeError("runaway")
        ans = r.request.options[rng.randrange(len(r.request.options))]
        trace.append(f"{r.request.player.id}:{display(ans)}")
        m.supply(ans)
        r = m.next()
    return trace, [p.id for p in r.winners]


def test_equivalence():
    bad = 0
    for game, seats in GAMES.items():
        program = parse(src(game))
        for np_ in seats:
            for seed in (1, 7, 42, 2024):
                ti, wi = interp_trace(program, np_, seed)
                tm, wm = machine_trace(program, np_, seed)
                if ti != tm or wi != wm:
                    bad += 1
                    print(f"  MISMATCH {game} np={np_} seed={seed}: "
                          f"len {len(ti)}/{len(tm)} winners {wi}/{wm}")
                    for i, (a, b) in enumerate(zip(ti, tm)):
                        if a != b:
                            print(f"    first diff @ {i}: interp={a!r} machine={b!r}")
                            break
        print(f"ok   {game} {seats}" if bad == 0 else f"FAIL {game}")
    assert bad == 0, f"{bad} mismatches"
    print("equivalence: Machine == Interpreter on all games ✓")


def drive_first(m, r):
    """Drive a machine to completion picking option 0; return winner ids."""
    g = 0
    while not r.done:
        g += 1
        if g > 500000:
            raise RuntimeError("runaway")
        m.supply(r.request.options[0])
        r = m.next()
    return [p.id for p in r.winners]


def test_clone():
    from cardsharp import RNG
    # 1) clone-and-continue equals no-clone: a clone driven the same way as the
    #    original must reach the same winners.
    program = parse(src("thirtyone"))
    m = Machine(program, GameState(2, 99, names=None), lambda req: req.options[0])
    m.state.globals["__quiet"] = True
    r = m.start()
    rng = random.Random(5)
    for _ in range(3):  # advance a few decisions
        if r.done:
            break
        m.supply(r.request.options[rng.randrange(len(r.request.options))])
        r = m.next()
    assert not r.done, "game ended before clone; pick another game/seed"
    c = m.clone()
    # both continue with option-0; clone must match original
    w_orig = drive_first(m, r)
    w_clone = drive_first(c, c.next())
    assert w_orig == w_clone, (w_orig, w_clone)
    print(f"clone-continue: original={w_orig} == clone={w_clone} ✓")

    # 2) determinizing a clone is independent (doesn't touch the original) and the
    #    clone still completes.
    m2 = Machine(program, GameState(2, 7), lambda req: req.options[0])
    m2.state.globals["__quiet"] = True
    r2 = m2.start()
    for _ in range(2):
        if r2.done:
            break
        m2.supply(r2.request.options[0])
        r2 = m2.next()
    assert not r2.done
    before = [c.id for pile in m2.state.shared_piles.values() for c in pile.cards]
    c2 = m2.clone()
    c2.state.determinize_in_place(c2.state.players[0], RNG(123))
    after = [c.id for pile in m2.state.shared_piles.values() for c in pile.cards]
    assert before == after, "determinizing the clone mutated the original!"
    w2 = drive_first(c2, c2.next())
    assert isinstance(w2, list)
    print(f"determinize-clone: original deck untouched, clone completed (winners {w2}) ✓")


if __name__ == "__main__":
    test_equivalence()
    test_clone()
    print("\nALL PASS")
