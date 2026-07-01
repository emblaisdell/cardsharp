"""Shared markdown report writer for the PyTorch self-play benchmarks. Used by
both run_experiments.py (sequential) and merge_results.py (parallel fragments)."""


def pct(x):
    return f"{100*x:.0f}%"


def write_report(rows, out, seconds, games):
    lines = []
    lines.append("# PyTorch self-play results (DMC & PPO)\n")
    lines.append(f"Auto-generated (--seconds {seconds:.0f} --games {games}). Single CPU, "
                 "one process per game (torch pinned to 1 thread each).\n")
    lines.append("All numbers are **win rate** (shared wins count as a win), averaged "
                 "over every seat orientation to cancel turn-order bias. `vs random` "
                 "= one trained seat against random opponents. Head-to-head = one seat "
                 "of A vs the rest filled by B.\n")
    lines.append("## vs random opponents\n")
    lines.append("| Game | seats | DMC | PPO | linear | random |")
    lines.append("|---|--:|--:|--:|--:|--:|")
    for r in rows:
        lin = pct(r["lin_vs_rand"]) if r.get("lin_vs_rand") is not None else "—"
        lines.append(f"| {r['game']} | {r['np']} | {pct(r['dmc_vs_rand'])} | "
                     f"{pct(r['ppo_vs_rand'])} | {lin} | {pct(r['rand_vs_rand'])} |")
    lines.append("\n## head-to-head (A win% / B win%)\n")
    lines.append("| Game | DMC vs linear | PPO vs linear | DMC vs PPO |")
    lines.append("|---|---|---|---|")
    for r in rows:
        dl = (f"{pct(r['dmc_vs_lin'][0])} / {pct(r['dmc_vs_lin'][1])}"
              if r.get("dmc_vs_lin") else "—")
        pl = (f"{pct(r['ppo_vs_lin'][0])} / {pct(r['ppo_vs_lin'][1])}"
              if r.get("ppo_vs_lin") else "—")
        dp = f"{pct(r['dmc_vs_ppo'][0])} / {pct(r['dmc_vs_ppo'][1])}"
        lines.append(f"| {r['game']} | {dl} | {pl} | {dp} |")
    lines.append("\n## compute used (per method, per game)\n")
    lines.append("| Game | DMC episodes / decisions / s | PPO episodes / decisions / s |")
    lines.append("|---|---|---|")
    for r in rows:
        d = r["dmc_info"]
        p = r["ppo_info"]
        lines.append(f"| {r['game']} | {d['episodes']} / {d['decisions']} / {d['seconds']:.0f}s "
                     f"| {p['episodes']} / {p['decisions']} / {p['seconds']:.0f}s |")
    lines.append("\n*DMC = Deep Monte-Carlo (DouZero-style); PPO = clipped policy "
                 "gradient with entropy bonus. Both share the same card-matrix + "
                 "per-option action-scoring network (`ml/net.py`). See "
                 "[ml-research.md](ml-research.md) for the method rationale. Long games "
                 "(Table-less, Money, Crazy Bridge, Go Fish) have hundreds–thousands of "
                 "decisions per episode, so they get fewer episodes per second.*\n")
    with open(out, "w") as f:
        f.write("\n".join(lines))
