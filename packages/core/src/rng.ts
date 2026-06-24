// A tiny seedable PRNG (mulberry32). Deterministic given a seed, so a game
// replays identically across machines from the same seed + move sequence.

export class RNG {
  private state: number;

  constructor(seed: number) {
    // ensure a non-zero 32-bit state
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  // returns a float in [0, 1)
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // integer in [0, n)
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  // in-place Fisher–Yates shuffle
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}
