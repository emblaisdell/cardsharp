"""PPO self-play — the simple, strong policy-gradient baseline that recent work
(arXiv:2502.08938) found competitive with CFR/NFSP/PSRO on imperfect-information
games, *with high entropy regularization*. Same network as DMC; the per-option
scorer produces policy logits and the value head is the baseline.

Episodic, terminal reward (win = 1, loss = 0). Advantage = return - V(s).

    python -m ml.ppo <game.card> [--players N] [--seconds S] [--out model.pt]
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


class PPOAgent:
    def __init__(self, net, rng=None, greedy=False, device="cpu"):
        self.net = net
        self.rng = rng or random.Random()
        self.greedy = greedy
        self.device = device

    def _logits(self, obs, options):
        sv = torch.from_numpy(state_features(obs)).to(self.device)
        om = torch.from_numpy(np.asarray(featurize_options(options, obs), dtype=np.float32)).to(self.device)
        h = self.net.embed(sv)
        return self.net.score_options(h, om), self.net.value_head(h).squeeze(-1)

    def choose_index(self, seat, obs, options, req):
        with torch.no_grad():
            logits, _ = self._logits(obs, options)
            if self.greedy:
                return int(torch.argmax(logits).item())
            p = torch.softmax(logits, dim=0).cpu().numpy()
        r = self.rng.random()
        c = 0.0
        for i, pi in enumerate(p):
            c += pi
            if r <= c:
                return i
        return len(p) - 1


def train(program, num_players, seconds=60.0, hidden=128, lr=3e-4,
          episodes_per_batch=24, epochs=3, clip=0.2, ent_coef=0.1,
          vf_coef=0.5, seed=0, log=print, device="cpu",
          eval_every=30.0, eval_games=6, eval_cap=1200):
    torch.manual_seed(seed)
    rng = random.Random(seed)
    net = CardNet(hidden).to(device)
    opt = torch.optim.Adam(net.parameters(), lr=lr)

    t0 = time.time()
    episodes = 0
    total_decisions = 0
    last_log = t0
    last_eval = t0

    while time.time() - t0 < seconds:
        # ---- collect a batch of self-play episodes ----
        # each transition: (state_vec, opt_rows, chosen_idx, old_logp, ret)
        batch = []
        agent = PPOAgent(net, rng=rng, device=device)
        for _ in range(episodes_per_batch):
            ep = []  # (seat, sv, opt_rows, chosen_idx, old_logp)

            def choose_index(seat, obs, options, req):
                sv = state_features(obs)
                rows = np.asarray(featurize_options(options, obs), dtype=np.float32)
                with torch.no_grad():
                    h = net.embed(torch.from_numpy(sv).to(device))
                    logits = net.score_options(h, torch.from_numpy(rows).to(device))
                    logp_all = torch.log_softmax(logits, dim=0)
                    probs = torch.softmax(logits, dim=0).cpu().numpy()
                r = rng.random()
                c = 0.0
                idx = len(probs) - 1
                for i, pi in enumerate(probs):
                    c += pi
                    if r <= c:
                        idx = i
                        break
                ep.append((seat, sv, rows, idx, float(logp_all[idx].item())))
                return idx

            ep_seed = rng.randrange(1, 2**31)
            winners, scores, ndec = play_episode(program, num_players, ep_seed, choose_index)
            total_decisions += ndec
            episodes += 1
            for seat, sv, rows, idx, old_logp in ep:
                ret = 1.0 if seat in winners else 0.0
                batch.append((sv, rows, idx, old_logp, ret))

        if not batch:
            continue
        rets = np.array([b[4] for b in batch], dtype=np.float32)

        # ---- PPO update (BATCHED with option padding + masking) ----
        for _ in range(epochs):
            order = list(range(len(batch)))
            rng.shuffle(order)
            MB = 256
            for s in range(0, len(order), MB):
                chunk = order[s:s + MB]
                b = len(chunk)
                nmax = max(batch[j][1].shape[0] for j in chunk)
                O = batch[chunk[0]][1].shape[1]
                sv = np.zeros((b, batch[chunk[0]][0].shape[0]), dtype=np.float32)
                opt_pad = np.zeros((b, nmax, O), dtype=np.float32)
                mask = np.zeros((b, nmax), dtype=np.float32)
                chosen = np.zeros(b, dtype=np.int64)
                old_lp = np.zeros(b, dtype=np.float32)
                ret_a = np.zeros(b, dtype=np.float32)
                for k, j in enumerate(chunk):
                    s_v, rows, idx, old_logp, ret = batch[j]
                    sv[k] = s_v
                    n = rows.shape[0]
                    opt_pad[k, :n] = rows
                    mask[k, :n] = 1.0
                    chosen[k] = idx
                    old_lp[k] = old_logp
                    ret_a[k] = ret
                svt = torch.from_numpy(sv).to(device)
                optt = torch.from_numpy(opt_pad).to(device)
                maskt = torch.from_numpy(mask).to(device)
                chosent = torch.from_numpy(chosen).to(device)
                old_lpt = torch.from_numpy(old_lp).to(device)
                rett = torch.from_numpy(ret_a).to(device)

                h = net.embed(svt)                                 # [B,H]
                v = net.value_head(h).squeeze(-1)                  # [B]
                logits = net.score_options_batched(h, optt, maskt)  # [B,N]
                logp_all = torch.log_softmax(logits, dim=1)
                p_all = torch.softmax(logits, dim=1)
                logp = logp_all.gather(1, chosent.unsqueeze(1)).squeeze(1)
                adv = rett - v.detach()
                if adv.numel() > 1:
                    adv = (adv - adv.mean()) / (adv.std() + 1e-6)
                ratio = torch.exp(logp - old_lpt)
                pol_loss = -torch.min(ratio * adv,
                                      torch.clamp(ratio, 1 - clip, 1 + clip) * adv).mean()
                lp_safe = torch.where(maskt.bool(), logp_all, torch.zeros_like(logp_all))
                ent = -(p_all * lp_safe).sum(dim=1).mean()
                val_loss = ((v - rett) ** 2).mean()
                loss = pol_loss + vf_coef * val_loss - ent_coef * ent
                opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
                opt.step()

        if time.time() - last_log > 5:
            log(f"  [ppo] {time.time()-t0:5.0f}s  eps={episodes:5d}  "
                f"winrate~{rets.mean():.2f}  batch={len(batch)}")
            last_log = time.time()

        # periodic eval vs a FIXED random opponent — the meaningful learning curve
        if eval_every and time.time() - last_eval > eval_every:
            wr = eval_vs_random(program, num_players, PPOAgent(net, greedy=True, device=device),
                                games=eval_games, base_seed=987654, max_decisions=eval_cap)
            log(f"  [ppo-eval] {time.time()-t0:5.0f}s  winrate_vs_random={wr:.3f}")
            last_eval = time.time()

    return net, {"episodes": episodes, "decisions": total_decisions,
                 "seconds": time.time() - t0, "method": "PPO"}


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
    print(f"Training PPO on {program.name} ({np_}p) for {args.seconds:.0f}s")
    net, info = train(program, np_, seconds=args.seconds, hidden=args.hidden, seed=args.seed)
    print("done:", info)
    out = args.out or f"models/py/{program.name.replace(' ', '_').lower()}_ppo.pt"
    import os
    os.makedirs(os.path.dirname(out), exist_ok=True)
    torch.save({"state_dict": net.state_dict(), "hidden": args.hidden, "info": info}, out)
    print("saved", out)


if __name__ == "__main__":
    main()
