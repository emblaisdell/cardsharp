"""A bit-exact port of the TS mulberry32 PRNG (packages/core/src/rng.ts).

Reproduces the same float stream given the same seed, so a Python self-play game
and the TS engine deal/shuffle identically. All arithmetic is masked to 32 bits
to mirror JS `Math.imul`, `>>> k`, and `| 0` semantics.
"""

MASK = 0xFFFFFFFF


class RNG:
    __slots__ = ("state",)

    def __init__(self, seed: int):
        self.state = (seed & MASK) or 0x9E3779B9

    def snapshot(self) -> int:
        return self.state

    def restore(self, s: int) -> None:
        self.state = s & MASK

    def clone(self) -> "RNG":
        r = RNG(0)
        r.state = self.state
        return r

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & MASK
        t = self.state
        t = (((t ^ (t >> 15)) & MASK) * (t | 1)) & MASK
        inner = (((t ^ (t >> 7)) & MASK) * (t | 61)) & MASK
        t = (t ^ ((t + inner) & MASK)) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0

    def int(self, n: int) -> int:
        return int(self.next() * n)

    def shuffle(self, arr: list) -> list:
        # in-place Fisher-Yates, identical order to the TS engine
        for i in range(len(arr) - 1, 0, -1):
            j = self.int(i + 1)
            arr[i], arr[j] = arr[j], arr[i]
        return arr
