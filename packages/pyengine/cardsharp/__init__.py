"""Python ♠# / CardSharp interpreter — a faithful port of the TS engine, for
in-process self-play training (see packages/ml).
"""

from .rng import RNG
from .values import (
    Card, Player, Pile, ZoneHandle, Labeled, CSRecord, Callable, Builtin,
    display, unwrap, same_value, truthy, type_name,
)
from .state import GameState
from .parser import parse, Node, ParseError
from .lexer import lex, LexError
from .interp import Interpreter, ChoiceRequest, GameOver, RuntimeError_
from .engine import compile_program, run_game, players_range

__all__ = [
    "RNG", "Card", "Player", "Pile", "ZoneHandle", "Labeled", "CSRecord",
    "Callable", "Builtin", "display", "unwrap", "same_value", "truthy", "type_name",
    "GameState", "parse", "Node", "ParseError", "lex", "LexError",
    "Interpreter", "ChoiceRequest", "GameOver", "RuntimeError_",
    "compile_program", "run_game", "players_range",
]
