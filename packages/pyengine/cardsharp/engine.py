"""High-level driver for the Python ♠# engine: parse a program, build state, run
to completion against a decide-callback (the controller/policy).

Type-checking is intentionally NOT ported here — the .card files are already
statically checked by the TS toolchain; this engine just runs them for self-play.
"""

from .parser import parse
from .state import GameState
from .interp import Interpreter, ChoiceRequest


def players_range(program):
    decl = next((s for s in program.sections if s.type == "PlayersDecl"), None)
    if not decl:
        return (2, 8)
    return (decl.min, decl.max)


def compile_program(source):
    return parse(source)


def run_game(source, decide, num_players=None, seed=1, names=None, quiet=True,
             on_announce=None):
    program = parse(source) if isinstance(source, str) else source
    lo, hi = players_range(program)
    np = num_players if num_players is not None else lo
    if np < lo or np > hi:
        raise ValueError(f'game "{program.name}" supports {lo}..{hi} players, got {np}')
    state = GameState(np, seed, names)
    if quiet:
        state.globals["__quiet"] = True
    if on_announce:
        state.on_announce = on_announce
    interp = Interpreter(program, state, decide)
    winners = interp.run()
    return winners, state, interp
