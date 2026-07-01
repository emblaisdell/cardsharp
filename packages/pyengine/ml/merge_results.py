"""Collect per-game result fragments (models/py/<game>_result.json) and write the
combined docs/ml-pytorch-results.md. Run after (or during) the parallel launcher.

    python -m ml.merge_results [--seconds S] [--games G]
"""

import argparse
import json
import os

from .report import write_report

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ORDER = ["blackjack", "gofish", "oldmaid", "thirtyone",
         "tableless", "thewall", "crazybridge", "moneymoneymoney"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=0)
    ap.add_argument("--games", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "ml-pytorch-results.md"))
    args = ap.parse_args()
    models = os.path.join(ROOT, "models", "py")
    rows = []
    for name in ORDER:
        p = os.path.join(models, f"{name}_result.json")
        if os.path.exists(p):
            with open(p) as f:
                rows.append(json.load(f))
    if not rows:
        print("no result fragments found in", models)
        return
    secs = args.seconds or rows[0].get("dmc_info", {}).get("seconds", 0)
    games = args.games or 0
    write_report(rows, args.out, secs, games)
    print(f"merged {len(rows)} games -> {args.out}")


if __name__ == "__main__":
    main()
