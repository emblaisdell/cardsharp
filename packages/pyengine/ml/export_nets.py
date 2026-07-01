"""Export trained DMC/PPO nets (models/py/<game>_<method>.pt) to plain JSON so the
TS engine can load and play them (to face the TS Information-Set MCTS).

    python -m ml.export_nets
Writes models/py/<game>_<method>.netjson
"""

import glob
import json
import os

import torch

from .features import STATE_DIM, OPTION_DIM

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def export(path):
    ck = torch.load(path, map_location="cpu")
    sd = ck["state_dict"]
    def m(k):
        return sd[k].tolist()
    out = {
        "hidden": ck["hidden"],
        "state_dim": STATE_DIM,
        "option_dim": OPTION_DIM,
        "method": ck["info"]["method"],
        "trunk0_w": m("trunk.0.weight"), "trunk0_b": m("trunk.0.bias"),
        "trunk2_w": m("trunk.2.weight"), "trunk2_b": m("trunk.2.bias"),
        "scorer0_w": m("scorer.0.weight"), "scorer0_b": m("scorer.0.bias"),
        "scorer2_w": m("scorer.2.weight"), "scorer2_b": m("scorer.2.bias"),
        # value head: trained by PPO (predicts win prob); for DMC it is untrained,
        # so the TS side uses max-Q as the leaf value instead.
        "value_w": m("value_head.weight"), "value_b": m("value_head.bias"),
    }
    dest = path[:-3] + ".netjson"
    with open(dest, "w") as f:
        json.dump(out, f)
    return dest


def main():
    pts = sorted(glob.glob(os.path.join(ROOT, "models", "py", "*_dmc.pt")) +
                 glob.glob(os.path.join(ROOT, "models", "py", "*_ppo.pt")))
    for p in pts:
        print("exported", os.path.basename(export(p)))


if __name__ == "__main__":
    main()
