"""AlphaZero-style policy iteration for ♠#, made possible by the cloneable Python
Machine (cardsharp/vm.py).

Loop: self-play where every move runs neural IS-MCTS (cardsharp Machine + the
current net) -> record (info-set, π = MCTS visit distribution, z = game outcome);
then train the net's policy head toward π and value head toward z; repeat. The
improved net makes the next round's search stronger (policy iteration).

    python -m ml.alphazero <game.card> [--players N] [--iters K] [--games G]
                           [--sims S] [--warm models/py/<game>_dmc.pt]
"""

import argparse
import os
import random
import time

import numpy as np
import torch

from cardsharp.parser import parse
from cardsharp.engine import players_range
from cardsharp.state import GameState
from cardsharp.vm import Machine
from cardsharp.rng import RNG
from .net import CardNet
from .features import state_features, featurize_options
from .search import mcts_visits, NetEval
from .dmc import DMCAgent
from .evaluate import eval_vs_random, RandomAgent

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def selfplay_game(program, np_, seed, neteval, sims, rng, temperature=1.0,
                  max_decisions=4000, leaf="rollout"):
    """One self-play game; every seat moves by MCTS. Returns the per-decision
    training rows and the winner set."""
    state = GameState(np_, seed)
    state.globals["__quiet"] = True
    m = Machine(program, state, lambda req: req.options[0])
    r = m.start()
    rows = []  # (seat, state_vec, opt_rows, pi)
    guard = 0
    while not r.done:
        guard += 1
        if guard > max_decisions:
            break
        req = r.request
        seat = req.player.id
        if len(req.options) == 1:
            m.supply(req.options[0]); r = m.next(); continue
        obs = m.state.observe(req.player)
        options, counts, _ = mcts_visits(m, seat, neteval, sims, rng, leaf=leaf)
        counts = np.asarray(counts, dtype=np.float64)
        if counts.sum() == 0:
            counts = np.ones(len(options))
        pi = counts / counts.sum()
        sv = state_features(obs)
        opt_rows = np.asarray(featurize_options(options, obs), dtype=np.float32)
        rows.append((seat, sv, opt_rows, pi.astype(np.float32)))
        # sample an action from the improved policy (temperature) for exploration
        probs = counts ** (1.0 / max(temperature, 1e-6))
        probs = probs / probs.sum()
        idx = rng_choice(probs, rng)
        m.supply(options[idx])
        r = m.next()
    winners = set(p.id for p in (r.winners or []))
    return rows, winners


def rng_choice(probs, rng):
    x = rng.next()
    c = 0.0
    for i, p in enumerate(probs):
        c += p
        if x <= c:
            return i
    return len(probs) - 1


def train_on_buffer(net, opt, buf, device, epochs=4, mb=128, vf_coef=1.0):
    """buf: list of (state_vec, opt_rows, pi, z). Policy CE toward π, value MSE
    toward z, with option padding + masking."""
    if not buf:
        return 0.0
    rng = random.Random(0)
    losses = []
    for _ in range(epochs):
        order = list(range(len(buf)))
        rng.shuffle(order)
        for s in range(0, len(order), mb):
            chunk = order[s:s + mb]
            b = len(chunk)
            nmax = max(buf[j][1].shape[0] for j in chunk)
            S = buf[chunk[0]][0].shape[0]
            O = buf[chunk[0]][1].shape[1]
            sv = np.zeros((b, S), dtype=np.float32)
            opt_pad = np.zeros((b, nmax, O), dtype=np.float32)
            pi_pad = np.zeros((b, nmax), dtype=np.float32)
            mask = np.zeros((b, nmax), dtype=np.float32)
            z = np.zeros(b, dtype=np.float32)
            for k, j in enumerate(chunk):
                s_v, rows, pi, zz = buf[j]
                n = rows.shape[0]
                sv[k] = s_v
                opt_pad[k, :n] = rows
                pi_pad[k, :n] = pi
                mask[k, :n] = 1.0
                z[k] = zz
            svt = torch.from_numpy(sv).to(device)
            optt = torch.from_numpy(opt_pad).to(device)
            maskt = torch.from_numpy(mask).to(device)
            pit = torch.from_numpy(pi_pad).to(device)
            zt = torch.from_numpy(z).to(device)
            h = net.embed(svt)
            logits = net.score_options_batched(h, optt, maskt)
            logp = torch.log_softmax(logits, dim=1)
            pol_loss = -(pit * torch.where(maskt.bool(), logp, torch.zeros_like(logp))).sum(dim=1).mean()
            v = net.value_head(h).squeeze(-1)
            val_loss = ((v - zt) ** 2).mean()
            loss = pol_loss + vf_coef * val_loss
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
            losses.append(loss.item())
    return sum(losses) / max(1, len(losses))


def train(program, np_, iters=8, games_per_iter=12, sims=30, lr=3e-4, hidden=128,
          warm=None, seed=0, device="cpu", log=print):
    torch.manual_seed(seed)
    rng = random.Random(seed)
    net = CardNet(hidden).to(device)
    start_tag = "random init"
    if warm and os.path.exists(warm):
        ck = torch.load(warm, map_location=device)
        net.load_state_dict(ck["state_dict"])
        start_tag = f"warm-start {os.path.basename(warm)}"
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    log(f"AlphaZero on {program.name} ({np_}p): {start_tag}, {iters} iters x "
        f"{games_per_iter} games x {sims} sims")

    info = {"iters": iters, "games_per_iter": games_per_iter, "sims": sims,
            "warm": start_tag, "decisions": 0, "selfplay_games": 0}
    # baseline: warm net's strength before any policy iteration
    base_wr = eval_vs_random(program, np_, DMCAgent(net, 0.0, device=device),
                             games=20, base_seed=4242, max_decisions=2000)
    info["start_vs_random"] = base_wr
    log(f"  start netVsRandom={base_wr:.2f}")

    replay = []                 # persistent replay buffer across iterations
    REPLAY_MAX = 8000
    t0 = time.time()
    best_wr = base_wr
    for it in range(iters):
        net.eval()
        neteval = NetEval(net, device=device, prior_temp=0.5)
        temp = 1.0 if it < iters // 2 else 0.5
        for g in range(games_per_iter):
            gseed = rng.randrange(1, 2**31)
            rows, winners = selfplay_game(program, np_, gseed, neteval, sims,
                                          RNG(gseed ^ 0xABCD), temperature=temp)
            for seat, sv, opt_rows, pi in rows:
                z = 1.0 if seat in winners else 0.0
                replay.append((sv, opt_rows, pi, z))
            info["selfplay_games"] += 1
            info["decisions"] += len(rows)
        if len(replay) > REPLAY_MAX:
            replay = replay[-REPLAY_MAX:]
        net.train()
        # train on the accumulated replay (fewer epochs, value down-weighted so a
        # cold value head can't wreck the policy trunk early)
        loss = train_on_buffer(net, opt, replay, device, epochs=2, vf_coef=0.5)
        net.eval()
        wr = eval_vs_random(program, np_, DMCAgent(net, 0.0, device=device),
                            games=20, base_seed=4242, max_decisions=2000)
        best_wr = max(best_wr, wr)
        log(f"  iter {it+1}/{iters}  replay={len(replay):5d}  loss={loss:.3f}  "
            f"netVsRandom={wr:.2f}  ({time.time()-t0:.0f}s)")
    info["seconds"] = time.time() - t0
    info["final_vs_random"] = wr
    info["best_vs_random"] = best_wr
    return net, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("game")
    ap.add_argument("--players", type=int, default=None)
    ap.add_argument("--iters", type=int, default=8)
    ap.add_argument("--games", type=int, default=12)
    ap.add_argument("--sims", type=int, default=30)
    ap.add_argument("--warm", default="auto")
    ap.add_argument("--out", default=None)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    program = parse(open(args.game).read())
    np_ = args.players or players_range(program)[0]
    name = os.path.splitext(os.path.basename(args.game))[0]
    warm = (os.path.join(ROOT, "models", "py", f"{name}_dmc.pt")
            if args.warm == "auto" else (args.warm or None))
    net, info = train(program, np_, iters=args.iters, games_per_iter=args.games,
                      sims=args.sims, warm=warm, seed=args.seed)
    print("done:", info)
    out = args.out or os.path.join(ROOT, "models", "py", f"{name}_az.pt")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    torch.save({"state_dict": net.state_dict(), "hidden": 128, "info": info}, out)
    print("saved", out)


if __name__ == "__main__":
    main()
