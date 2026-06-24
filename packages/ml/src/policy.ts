// A linear softmax policy: score each option row by a dot product with a weight
// vector, then pick by softmax (training) or argmax (play). The entire model is
// this weight vector — a few dozen floats, trivially serialized to JSON.

import { DIM, FEATURE_NAMES } from "./features.ts";

export interface ModelJSON {
  game: string;
  dim: number;
  featureNames: string[];
  weights: number[];
  trainedGames: number;
}

export class LinearPolicy {
  weights: number[];

  constructor(weights?: number[]) {
    this.weights = weights ? weights.slice() : new Array(DIM).fill(0);
  }

  score(row: number[]): number {
    let s = 0;
    for (let i = 0; i < this.weights.length; i++) s += this.weights[i] * row[i];
    return s;
  }

  // softmax probabilities over option rows (numerically stable)
  probs(rows: number[][], temperature = 1): number[] {
    const z = rows.map((r) => this.score(r) / Math.max(temperature, 1e-6));
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const sum = e.reduce((a, b) => a + b, 0) || 1;
    return e.map((v) => v / sum);
  }

  argmax(rows: number[][]): number {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      const s = this.score(rows[i]);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  }

  sample(rows: number[][], temperature: number, rand: () => number): number {
    const p = this.probs(rows, temperature);
    let r = rand();
    for (let i = 0; i < p.length; i++) {
      r -= p[i];
      if (r <= 0) return i;
    }
    return p.length - 1;
  }

  toJSON(game: string, trainedGames: number): ModelJSON {
    return {
      game,
      dim: DIM,
      featureNames: FEATURE_NAMES,
      weights: this.weights.slice(),
      trainedGames,
    };
  }

  static fromJSON(m: ModelJSON): LinearPolicy {
    return new LinearPolicy(m.weights);
  }
}
