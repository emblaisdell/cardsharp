"""In-process neural Information-Set MCTS on the Python resumable Machine.

Used both as a strong player and — crucially — inside the AlphaZero training loop,
where each self-play move runs this search to produce an improved policy target
(the root visit distribution) and a value target (the game outcome).

Mirrors packages/ml/src/neural-ismcts.ts: clone the Machine, determinize from the
searcher's view, descend with PUCT (net prior), evaluate a leaf with the net value
(AlphaZero `leaf="net"`) or a heuristic rollout (`leaf="rollout"`).
"""

import math
import numpy as np
import torch

from cardsharp.rng import RNG
from cardsharp.values import unwrap, Card, Player
from .features import state_features, featurize_options


class NetEval:
    """Wraps a CardNet to give a PUCT prior + value for a (obs, options)."""

    def __init__(self, net, device="cpu", prior_temp=0.5, dmc_value=False):
        self.net = net
        self.device = device
        self.prior_temp = prior_temp
        self.dmc_value = dmc_value  # True -> value = max scorer output (DMC-style)

    def policy_value(self, obs, options):
        sv = torch.from_numpy(state_features(obs)).to(self.device)
        rows = np.asarray(featurize_options(options, obs), dtype=np.float32)
        om = torch.from_numpy(rows).to(self.device)
        with torch.no_grad():
            h = self.net.embed(sv)
            scores = self.net.score_options(h, om).cpu().numpy()
            if self.dmc_value:
                value = float(np.clip(scores.max(), 0.0, 1.0))
            else:
                value = float(np.clip(self.net.value_head(h).item(), 0.0, 1.0))
        z = scores / max(self.prior_temp, 1e-6)
        z -= z.max()
        e = np.exp(z)
        priors = e / (e.sum() or 1.0)
        return priors, value, rows


def key_of(o):
    o = unwrap(o)
    if o is None:
        return "_"
    if isinstance(o, Card):
        return "c" + str(o.id)
    if isinstance(o, Player):
        return "p" + str(o.id)
    if isinstance(o, list):
        return "L" + ",".join(sorted(key_of(x) for x in o))
    if isinstance(o, bool):
        return "bT" if o else "bF"
    if isinstance(o, (int, float)):
        return "n" + str(o)
    return "s" + str(o)


def option_for_key(k, options):
    for o in options:
        if key_of(o) == k:
            return o
    return None if k == "_" else (options[0] if options else None)


def _puct_select(node, keys, c):
    sqrtN = math.sqrt(node["visits"] + 1)
    best = keys[0]
    best_s = -1e18
    for k in keys:
        ch = node["children"].get(k)
        if ch is None:
            continue
        q = ch["value"] / ch["visits"] if ch["visits"] > 0 else 0.0
        u = c * ch["prior"] * sqrtN / (1 + ch["visits"])
        s = q + u
        if s > best_s:
            best_s = s
            best = k
    return best


def _rollout(sim, our_seat, depth_limit, rng):
    depth = 0
    r = None
    while not sim.is_done:
        req = sim.current_request
        if req is None:
            r = sim.next()
            if r.done:
                break
            req = sim.current_request
        if req.player.id == our_seat:
            depth += 1
            if depth > depth_limit:
                return _score_reward(sim, our_seat)
        opts = req.options
        sim.supply(opts[rng.int(len(opts))] if opts else None)
        r = sim.next()
    return 1.0 if any(p.id == our_seat for p in (sim.winners or [])) else 0.0


def _score_reward(sim, our_seat):
    mine = sim.score_of(sim.state.players[our_seat])
    beat = 0.0
    total = 0
    for p in sim.state.players:
        if p.id == our_seat:
            continue
        total += 1
        s = sim.score_of(p)
        if mine > s:
            beat += 1
        elif mine == s:
            beat += 0.5
    return beat / total if total else (1.0 if mine > 0 else 0.5)


def mcts_visits(machine, our_seat, neteval, sims, rng, c=1.5, leaf="net", rollout_depth=20):
    """Run `sims` IS-MCTS simulations from the machine's current decision for
    `our_seat`. Returns (options, visit_counts, root_value_estimate)."""
    req = machine.current_request
    options = req.options
    if len(options) <= 1:
        return options, [1] * len(options), 0.5
    nodes = {}
    for it in range(sims):
        sim = machine.clone()
        sim.state.globals["__quiet"] = True
        sim.state.determinize_in_place(
            sim.state.players[our_seat], RNG((rng.int(1 << 30) ^ (it * 0x9E3779B1)) & 0xFFFFFFFF))
        _iterate(nodes, sim, our_seat, neteval, c, leaf, rollout_depth, rng)
    root = nodes.get("")
    counts = []
    for o in options:
        ch = root["children"].get(key_of(o)) if root else None
        counts.append(ch["visits"] if ch else 0)
    rootval = 0.0
    if root and root["visits"]:
        tot = sum(ch["visits"] * (ch["value"] / ch["visits"] if ch["visits"] else 0)
                  for ch in root["children"].values())
        rootval = tot / max(1, sum(ch["visits"] for ch in root["children"].values()))
    return options, counts, rootval


def _iterate(nodes, sim, our_seat, neteval, c, leaf, rollout_depth, rng):
    path = []
    visited = []
    r = None
    while not sim.is_done:
        req = sim.current_request
        if req is None:
            r = sim.next()
            if r.done:
                break
            req = sim.current_request
        if req.player.id == our_seat:
            ps = "/".join(path)
            node = nodes.get(ps)
            if node is None:
                obs = sim.state.observe(sim.state.players[our_seat])
                priors, value, _ = neteval.policy_value(obs, req.options)
                children = {}
                for i, o in enumerate(req.options):
                    children[key_of(o)] = {"visits": 0, "value": 0.0, "prior": float(priors[i]) if i < len(priors) else 0.0}
                nodes[ps] = {"visits": 0, "children": children}
                leaf_val = value if leaf == "net" else _rollout(sim, our_seat, rollout_depth, rng)
                _backprop(nodes, visited, leaf_val)
                return
            keys = [key_of(o) for o in req.options]
            for k in keys:
                if k not in node["children"]:
                    node["children"][k] = {"visits": 0, "value": 0.0, "prior": 1.0 / len(keys)}
            ck = _puct_select(node, keys, c)
            visited.append((ps, ck))
            path.append(ck)
            action = option_for_key(ck, req.options)
        else:
            opts = req.options
            action = opts[rng.int(len(opts))] if opts else None
        sim.supply(action)
        r = sim.next()
    reward = 1.0 if any(p.id == our_seat for p in (sim.winners or [])) else 0.0
    _backprop(nodes, visited, reward)


def _backprop(nodes, visited, reward):
    for ps, ck in visited:
        n = nodes[ps]
        n["visits"] += 1
        ch = n["children"][ck]
        ch["visits"] += 1
        ch["value"] += reward
