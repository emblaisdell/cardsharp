"""Train DMC + PPO on ONE game, evaluate, and dump a JSON result fragment.
Designed to run as an independent process (one per game) so several games train
in parallel on separate cores. torch is pinned to 1 thread to avoid
oversubscription when many of these run at once.

    python -m ml.train_one <game-file> <players> <seconds> <eval_games> [hidden]
"""

import json
import os
import sys
import time

import torch
torch.set_num_threads(1)

from cardsharp.parser import parse
from cardsharp.engine import players_range
from .dmc import train as dmc_train, DMCAgent
from .ppo import train as ppo_train, PPOAgent
from .evaluate import eval_vs_random, match, RandomAgent
from .linear import LinearPolicy

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def main():
    game_file = sys.argv[1]
    players = int(sys.argv[2])
    seconds = float(sys.argv[3])
    eval_games = int(sys.argv[4])
    hidden = int(sys.argv[5]) if len(sys.argv) > 5 else 128
    eval_cap = int(sys.argv[6]) if len(sys.argv) > 6 else 1500

    name = os.path.splitext(os.path.basename(game_file))[0]
    program = parse(open(game_file).read())
    models = os.path.join(ROOT, "models", "py")
    os.makedirs(models, exist_ok=True)

    log = lambda *a: print(f"[{name}]", *a, flush=True)
    log(f"start {program.name} {players}p seconds={seconds:.0f} eval_games={eval_games}")

    t0 = time.time()
    dmc_net, dmc_info = dmc_train(program, players, seconds=seconds, hidden=hidden, log=log)
    torch.save({"state_dict": dmc_net.state_dict(), "hidden": hidden, "info": dmc_info},
               os.path.join(models, f"{name}_dmc.pt"))
    log("DMC trained", dmc_info)
    ppo_net, ppo_info = ppo_train(program, players, seconds=seconds, hidden=hidden, log=log)
    torch.save({"state_dict": ppo_net.state_dict(), "hidden": hidden, "info": ppo_info},
               os.path.join(models, f"{name}_ppo.pt"))
    log("PPO trained", ppo_info)
    dmc_net.eval()
    ppo_net.eval()

    dmc = DMCAgent(dmc_net, epsilon=0.0)
    ppo = PPOAgent(ppo_net, greedy=True)
    lin = None
    lin_path = os.path.join(ROOT, "models", f"{name}.json")
    if os.path.exists(lin_path):
        lin = LinearPolicy.load(lin_path)

    def ev_rand(agent):
        return eval_vs_random(program, players, agent, games=eval_games, max_decisions=eval_cap)

    def mt(a, b):
        return match(program, players, a, b, games=eval_games, max_decisions=eval_cap)

    log("evaluating...")
    r = {"game": program.name, "np": players, "name": name}
    r["dmc_vs_rand"] = ev_rand(dmc)
    r["ppo_vs_rand"] = ev_rand(ppo)
    r["rand_vs_rand"] = ev_rand(RandomAgent(1))
    r["lin_vs_rand"] = ev_rand(lin) if lin is not None else None
    r["dmc_vs_lin"] = mt(dmc, lin) if lin is not None else None
    r["ppo_vs_lin"] = mt(ppo, lin) if lin is not None else None
    r["dmc_vs_ppo"] = mt(dmc, ppo)
    r["dmc_info"] = dmc_info
    r["ppo_info"] = ppo_info
    r["wall"] = time.time() - t0

    out = os.path.join(models, f"{name}_result.json")
    with open(out, "w") as f:
        json.dump(r, f, indent=2)
    log(f"done in {r['wall']:.0f}s  DMC vs rand {r['dmc_vs_rand']:.2f}  "
        f"PPO vs rand {r['ppo_vs_rand']:.2f}  rand {r['rand_vs_rand']:.2f}  -> {out}")


if __name__ == "__main__":
    main()
