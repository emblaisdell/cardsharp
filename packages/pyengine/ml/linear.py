"""Load and play the TS linear softmax models (models/<game>.json) so the neural
agents can be benchmarked head-to-head against the existing baseline."""

import json
import numpy as np

from .features import featurize_options


class LinearPolicy:
    def __init__(self, weights):
        self.w = np.asarray(weights, dtype=np.float32)

    @classmethod
    def load(cls, path):
        with open(path) as f:
            m = json.load(f)
        return cls(m["weights"])

    def scores(self, obs, options):
        rows = np.asarray(featurize_options(options, obs), dtype=np.float32)
        return rows @ self.w

    def choose_index(self, seat, obs, options, req, temperature=0.0, rng=None):
        s = self.scores(obs, options)
        if temperature <= 0:
            return int(np.argmax(s))
        z = s / max(temperature, 1e-6)
        z -= z.max()
        e = np.exp(z)
        p = e / e.sum()
        r = (rng.random() if rng is not None else np.random.random())
        c = 0.0
        for i, pi in enumerate(p):
            c += pi
            if r <= c:
                return i
        return len(p) - 1
