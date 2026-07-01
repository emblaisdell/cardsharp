"""Deep Monte-Carlo (DMC) self-play — the DouZero recipe (arXiv:2106.06135).

All seats share the current network. Behaviour is epsilon-greedy over Q(s, a),
where each legal action a is scored by the per-option action scorer. At episode
end we regress Q of every taken action toward the seat's Monte-Carlo return
(here: win = 1, loss = 0 -> Q approximates this seat's win probability). This is
the smallest robust step beyond the linear policy and handles variable, large
action sets via action encoding.

    python -m ml.dmc <game.card> [--players N] [--seconds S] [--out model.pt]
"""

import argparse
import time
import random

import numpy as np
import torch

from .net import CardNet
from .features import state_features, featurize_options
from .selfplay import play_episode
from .evaluate import eval_vs_random
from cardsharp.parser import parse


class DMCAgent:
    """Greedy (or epsilon-greedy) Q action selection for play and self-play."""

    def __init__(self, net, epsilon=0.0, rng=None, device="cpu"):
        self.net = net
        self.epsilon = epsilon
        self.rng = rng or random.Random()
        self.device = device

    def q_scores(self, obs, options):
        sv = torch.from_numpy(state_features(obs)).to(self.device)
        om = torch.from_numpy(np.asarray(featurize_options(options, obs), dtype=np.float32)).to(self.device)
        with torch.no_grad():
            h = self.net.embed(sv)
            q = self.net.score_options(h, om)
        return q.cpu().numpy()

    def choose_index(self, seat, obs, options, req):
        if self.epsilon > 0 and self.rng.random() < self.epsilon:
            return self.rng.randrange(len(options))
        return int(np.argmax(self.q_scores(obs, options)))


def train(program, num_players, seconds=60.0, hidden=128, lr=1e-3,
          batch_size=256, eps_start=0.5, eps_end=0.05, seed=0,
          log=print, device="cpu", eval_every=30.0, eval_games=6, eval_cap=1200):
    torch.manual_seed(seed)
    rng = random.Random(seed)
    net = CardNet(hidden).to(device)
    opt = torch.optim.Adam(net.parameters(), lr=lr)

    # replay buffer of (state_vec, chosen_option_row, target)
    buf_s, buf_o, buf_t = [], [], []
    BUF_MAX = 200_000

    t0 = time.time()
    episodes = 0
    losses = []
    last_log = t0
    last_eval = t0
    total_decisions = 0

    while time.time() - t0 < seconds:
        eps = eps_end + (eps_start - eps_end) * max(0.0, 1 - (time.time() - t0) / seconds)
        agent = DMCAgent(net, epsilon=eps, rng=rng, device=device)
        # record decisions per seat for this episode
        ep_rows = []  # (seat, state_vec, chosen_row)

        def choose_index(seat, obs, options, req):
            sv = state_features(obs)
            rows = featurize_options(options, obs)
            idx = agent.choose_index(seat, obs, options, req)
            ep_rows.append((seat, sv, np.asarray(rows[idx], dtype=np.float32)))
            return idx

        ep_seed = rng.randrange(1, 2**31)
        winners, scores, ndec = play_episode(program, num_players, ep_seed, choose_index)
        total_decisions += ndec
        for seat, sv, row in ep_rows:
            target = 1.0 if seat in winners else 0.0
            buf_s.append(sv)
            buf_o.append(row)
            buf_t.append(target)
        if len(buf_s) > BUF_MAX:
            buf_s = buf_s[-BUF_MAX:]
            buf_o = buf_o[-BUF_MAX:]
            buf_t = buf_t[-BUF_MAX:]
        episodes += 1

        # a few gradient steps per episode once we have data
        if len(buf_s) >= batch_size:
            for _ in range(4):
                idxs = [rng.randrange(len(buf_s)) for _ in range(batch_size)]
                sv = torch.from_numpy(np.stack([buf_s[i] for i in idxs])).to(device)
                ro = torch.from_numpy(np.stack([buf_o[i] for i in idxs])).to(device)
                tg = torch.tensor([buf_t[i] for i in idxs], dtype=torch.float32, device=device)
                h = net.trunk(sv)
                q = net.scorer(torch.cat([h, ro], dim=1)).squeeze(1)
                loss = torch.nn.functional.mse_loss(q, tg)
                opt.zero_grad()
                loss.backward()
                opt.step()
                losses.append(loss.item())

        if time.time() - last_log > 5:
            avg = sum(losses[-200:]) / max(1, len(losses[-200:]))
            log(f"  [dmc] {time.time()-t0:5.0f}s  eps={episodes:5d}  "
                f"buf={len(buf_s):6d}  loss={avg:.4f}  eps_greedy={eps:.2f}")
            last_log = time.time()

        # periodic eval vs a FIXED random opponent — the meaningful learning curve
        if eval_every and len(buf_s) >= batch_size and time.time() - last_eval > eval_every:
            wr = eval_vs_random(program, num_players, DMCAgent(net, 0.0, device=device),
                                games=eval_games, base_seed=987654, max_decisions=eval_cap)
            log(f"  [dmc-eval] {time.time()-t0:5.0f}s  winrate_vs_random={wr:.3f}")
            last_eval = time.time()

    return net, {"episodes": episodes, "decisions": total_decisions,
                 "seconds": time.time() - t0, "method": "DMC"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("game")
    ap.add_argument("--players", type=int, default=None)
    ap.add_argument("--seconds", type=float, default=60.0)
    ap.add_argument("--hidden", type=int, default=128)
    ap.add_argument("--out", default=None)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    with open(args.game) as f:
        program = parse(f.read())
    from cardsharp.engine import players_range
    np_ = args.players or players_range(program)[0]
    print(f"Training DMC on {program.name} ({np_}p) for {args.seconds:.0f}s")
    net, info = train(program, np_, seconds=args.seconds, hidden=args.hidden, seed=args.seed)
    print("done:", info)
    out = args.out or f"models/py/{program.name.replace(' ', '_').lower()}_dmc.pt"
    import os
    os.makedirs(os.path.dirname(out), exist_ok=True)
    torch.save({"state_dict": net.state_dict(), "hidden": args.hidden, "info": info}, out)
    print("saved", out)


if __name__ == "__main__":
    main()
