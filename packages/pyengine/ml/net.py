"""Shared neural encoder for ♠# agents (DMC and PPO use the same architecture).

Design (DouZero-style action encoding, see docs/ml-research.md):
  * a permutation-invariant card-matrix STATE vector -> trunk MLP -> state embed h
  * each legal OPTION is encoded as a generic feature row; the scorer takes
    (h, option_row) -> one scalar per option. This handles a VARIABLE number of
    legal moves and makes one network work across every game.
  * a value head predicts the acting seat's outcome from h.

For DMC the per-option scalar is Q(s, a) ~= P(this seat wins | take a).
For PPO the per-option scalars are policy logits and the value head is the
state-value baseline.
"""

import torch
import torch.nn as nn

from .features import STATE_DIM, OPTION_DIM


class CardNet(nn.Module):
    def __init__(self, hidden=128):
        super().__init__()
        self.trunk = nn.Sequential(
            nn.Linear(STATE_DIM, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
        )
        self.scorer = nn.Sequential(
            nn.Linear(hidden + OPTION_DIM, hidden), nn.ReLU(),
            nn.Linear(hidden, 1),
        )
        self.value_head = nn.Linear(hidden, 1)

    def embed(self, state_vec):
        return self.trunk(state_vec)

    def score_options(self, h, opt_mat):
        # h: [H]; opt_mat: [n,O] (single decision) -> [n]
        n = opt_mat.shape[0]
        hexp = h.unsqueeze(0).expand(n, -1)
        return self.scorer(torch.cat([hexp, opt_mat], dim=1)).squeeze(1)

    def score_options_batched(self, h, opt, mask):
        # h:[B,H], opt:[B,N,O], mask:[B,N] (1 valid / 0 pad) -> logits [B,N]
        b, n, _ = opt.shape
        hexp = h.unsqueeze(1).expand(b, n, -1)
        s = self.scorer(torch.cat([hexp, opt], dim=2)).squeeze(-1)
        return s.masked_fill(mask == 0, float("-inf"))

    def forward(self, state_vec, opt_mat):
        h = self.embed(state_vec)
        scores = self.score_options(h, opt_mat)
        v = self.value_head(h).squeeze(-1)
        return scores, v
