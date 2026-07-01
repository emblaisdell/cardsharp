"""Live training dashboard. A zero-dependency HTTP server that parses the per-game
training logs (and result fragments) on each poll and serves an auto-refreshing
page with **DMC loss** and **PPO win-rate** curves per game, plus a status table.

    python -m ml.dashboard [port] [logdir]
    # then open http://localhost:<port>

Works with both run_long.sh (parallel) and a single `ml.train_one`, live.
"""

import glob
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
LOGDIR = sys.argv[2] if len(sys.argv) > 2 else "/tmp/claude-1000"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

DMC_RE = re.compile(r"\[(\w+)\]\s+\[dmc\]\s+(\d+)s\s+eps=\s*(\d+)\s+buf=\s*(\d+)\s+loss=([\d.]+)\s+eps_greedy=([\d.]+)")
PPO_RE = re.compile(r"\[(\w+)\]\s+\[ppo\]\s+(\d+)s\s+eps=\s*(\d+)\s+winrate~([\d.eE+-]+)\s+batch=(\d+)")
EVAL_RE = re.compile(r"\[(\w+)\]\s+\[(dmc|ppo)-eval\]\s+(\d+)s\s+winrate_vs_random=([\d.]+)")
ORDER = ["blackjack", "gofish", "oldmaid", "thirtyone",
         "tableless", "thewall", "crazybridge", "moneymoneymoney"]


def parse_log(path):
    dmc, ppo, dmc_eval, ppo_eval = [], [], [], []
    phase = "pending"
    title = None
    with open(path, errors="ignore") as f:
        for line in f:
            m = EVAL_RE.search(line)
            if m:
                pt = {"t": int(m.group(3)), "winrate": float(m.group(4))}
                (dmc_eval if m.group(2) == "dmc" else ppo_eval).append(pt)
                continue
            m = DMC_RE.search(line)
            if m:
                dmc.append({"t": int(m.group(2)), "eps": int(m.group(3)),
                            "buf": int(m.group(4)), "loss": float(m.group(5)),
                            "eps_greedy": float(m.group(6))})
                phase = "training DMC"
                continue
            m = PPO_RE.search(line)
            if m:
                ppo.append({"t": int(m.group(2)), "eps": int(m.group(3)),
                            "winrate": float(m.group(4)), "batch": int(m.group(5))})
                phase = "training PPO"
                continue
            if "] DMC trained" in line:
                phase = "DMC done"
            elif "] PPO trained" in line:
                phase = "PPO done"
            elif "] evaluating" in line:
                phase = "evaluating"
            elif "] done in" in line:
                phase = "done"
            elif "] start " in line and title is None:
                rest = line.split("] start ", 1)[1].strip()
                m2 = re.match(r"(.*?)\s+\d+p\b", rest)
                title = m2.group(1) if m2 else rest
    return dmc, ppo, dmc_eval, ppo_eval, phase, title


def collect():
    games = []
    seen = set()
    for name in ORDER + sorted(
            os.path.basename(p)[len("train_"):-4]
            for p in glob.glob(os.path.join(LOGDIR, "train_*.log"))):
        if name in seen:
            continue
        seen.add(name)
        logp = os.path.join(LOGDIR, f"train_{name}.log")
        dmc, ppo, dmc_eval, ppo_eval, phase, title = ([], [], [], [], "pending", None)
        if os.path.exists(logp):
            dmc, ppo, dmc_eval, ppo_eval, phase, title = parse_log(logp)
        resp = os.path.join(ROOT, "models", "py", f"{name}_result.json")
        result = None
        if os.path.exists(resp):
            try:
                with open(resp) as f:
                    result = json.load(f)
            except Exception:
                result = None
        if not dmc and not ppo and result is None:
            continue
        games.append({"name": name, "title": title or (result or {}).get("game", name),
                      "phase": phase, "dmc": dmc, "ppo": ppo,
                      "dmc_eval": dmc_eval, "ppo_eval": ppo_eval, "result": result})
    return {"games": games}


HTML = r"""<!doctype html><html><head><meta charset="utf-8">
<title>♠# training dashboard</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0e1117;color:#d7dce3;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
  header{padding:14px 20px;border-bottom:1px solid #232a35;display:flex;align-items:center;gap:14px}
  h1{font-size:17px;margin:0;font-weight:600}
  .muted{color:#7d8696}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px;padding:18px}
  .card{background:#151a22;border:1px solid #232a35;border-radius:10px;padding:14px}
  .card h2{font-size:15px;margin:0 0 2px}
  .row{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .badge{font-size:11px;padding:2px 8px;border-radius:20px;background:#222b38;color:#9fb0c7}
  .badge.done{background:#15331f;color:#69d98a}
  .badge.eval{background:#33270f;color:#e0b35a}
  .badge.train{background:#16283d;color:#5aa9e0}
  .charts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}
  .chart h3{font-size:11px;margin:0 0 2px;color:#9aa4b2;font-weight:500;text-transform:uppercase;letter-spacing:.04em}
  svg{width:100%;height:120px;display:block;background:#0e1117;border:1px solid #1d2530;border-radius:6px}
  .res{margin-top:10px;font-size:12px;border-collapse:collapse;width:100%}
  .res td{padding:2px 6px;border-top:1px solid #1d2530}
  .res .k{color:#8b94a3}
  .win{color:#69d98a;font-weight:600}
  .lose{color:#e07a7a}
  .last{font-variant-numeric:tabular-nums}
  a{color:#5aa9e0}
</style></head><body>
<header><h1>♠# training dashboard</h1>
  <span class="muted" id="status">connecting…</span>
  <span class="muted" style="margin-left:auto" id="updated"></span>
</header>
<div class="grid" id="grid"></div>
<script>
function path(points, w, h, xmax, ymin, ymax, pad){
  if(!points.length) return "";
  const sx = x => pad + (w-2*pad) * (xmax? x/xmax : 0);
  const sy = y => h-pad - (h-2*pad) * (ymax>ymin ? (y-ymin)/(ymax-ymin) : 0);
  return points.map((p,i)=>(i?"L":"M")+sx(p.x).toFixed(1)+" "+sy(p.y).toFixed(1)).join(" ");
}
function chart(series, color, yfix){
  const w=380,h=120,pad=22;
  if(!series.length) return '<svg viewBox="0 0 '+w+' '+h+'"><text x="'+w/2+'" y="'+h/2+'" fill="#46505f" text-anchor="middle" font-size="12">no data yet</text></svg>';
  const xmax = Math.max(...series.map(p=>p.x),1);
  let ymin = Math.min(...series.map(p=>p.y));
  let ymax = Math.max(...series.map(p=>p.y));
  if(yfix){ymin=0;ymax=1;} else {const pd=(ymax-ymin)*0.08||0.01;ymax+=pd;ymin=Math.max(0,ymin-pd);}
  const d = path(series.map(p=>({x:p.x,y:p.y})), w,h,xmax,ymin,ymax,pad);
  const last = series[series.length-1].y;
  // gridlines
  let g="";
  for(let i=0;i<=2;i++){const yy=pad+(h-2*pad)*i/2; const val=(ymax-(ymax-ymin)*i/2);
    g+='<line x1="'+pad+'" y1="'+yy+'" x2="'+(w-pad)+'" y2="'+yy+'" stroke="#1d2530"/>'+
       '<text x="2" y="'+(yy+3)+'" fill="#56606f" font-size="9">'+val.toFixed(2)+'</text>';}
  return '<svg viewBox="0 0 '+w+' '+h+'">'+g+
    '<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="1.6"/>'+
    '<text x="'+(w-pad)+'" y="13" fill="'+color+'" text-anchor="end" font-size="11" class="last">'+last.toFixed(3)+'</text>'+
    '<text x="'+(w-pad)+'" y="'+(h-6)+'" fill="#56606f" text-anchor="end" font-size="9">'+xmax+'s</text>'+
    '</svg>';
}
function chart2(sA,colA,sB,colB){
  const w=380,h=120,pad=22, all=[...sA,...sB];
  if(!all.length) return '<svg viewBox="0 0 '+w+' '+h+'"><text x="'+w/2+'" y="'+h/2+'" fill="#46505f" text-anchor="middle" font-size="12">no eval points yet</text></svg>';
  const xmax=Math.max(...all.map(p=>p.x),1), ymin=0, ymax=1;
  let g="";
  for(let i=0;i<=2;i++){const yy=pad+(h-2*pad)*i/2;
    g+='<line x1="'+pad+'" y1="'+yy+'" x2="'+(w-pad)+'" y2="'+yy+'" stroke="#1d2530"/>'+
       '<text x="2" y="'+(yy+3)+'" fill="#56606f" font-size="9">'+(1-i*0.5).toFixed(1)+'</text>';}
  function poly(s,col,yo){ if(!s.length) return "";
    const d=path(s.map(p=>({x:p.x,y:p.y})),w,h,xmax,ymin,ymax,pad);
    return '<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.7"/>'+
      '<text x="'+(w-pad)+'" y="'+yo+'" fill="'+col+'" text-anchor="end" font-size="11" class="last">'+s[s.length-1].y.toFixed(2)+'</text>';}
  return '<svg viewBox="0 0 '+w+' '+h+'">'+g+poly(sA,colA,13)+poly(sB,colB,26)+
    '<text x="'+(w-pad)+'" y="'+(h-6)+'" fill="#56606f" text-anchor="end" font-size="9">'+xmax+'s</text></svg>';
}
function pct(x){return x==null?"—":Math.round(100*x)+"%";}
function badge(phase){
  let c="train",t=phase;
  if(phase==="done"){c="done";} else if(phase==="evaluating"){c="eval";}
  else if(phase==="pending"){c="";}
  return '<span class="badge '+c+'">'+t+'</span>';
}
function resTable(r){
  if(!r) return "";
  const hh=(p)=>p?('<span class="'+(p[0]>=p[1]?'win':'lose')+'">'+pct(p[0])+'</span> / '+pct(p[1])):"—";
  return '<table class="res">'+
   '<tr><td class="k">vs random</td><td>DMC <b class="win">'+pct(r.dmc_vs_rand)+'</b></td>'+
   '<td>PPO <b class="win">'+pct(r.ppo_vs_rand)+'</b></td>'+
   '<td>linear '+pct(r.lin_vs_rand)+'</td><td>rand '+pct(r.rand_vs_rand)+'</td></tr>'+
   '<tr><td class="k">head-to-head</td><td colspan="2">DMC v lin '+hh(r.dmc_vs_lin)+'</td>'+
   '<td colspan="2">DMC v PPO '+hh(r.dmc_vs_ppo)+'</td></tr></table>';
}
async function tick(){
  let d; try{ d = await (await fetch('/metrics')).json(); }
  catch(e){ document.getElementById('status').textContent='waiting for server…'; return; }
  const done = d.games.filter(g=>g.phase==='done').length;
  document.getElementById('status').textContent = done+' / '+d.games.length+' games complete';
  document.getElementById('updated').textContent = 'updated '+new Date().toLocaleTimeString();
  const grid = document.getElementById('grid');
  grid.innerHTML = d.games.map(g=>{
    const dmc = g.dmc.map(p=>({x:p.t,y:p.loss}));
    const ppo = g.ppo.map(p=>({x:p.t,y:p.winrate}));
    const de = (g.dmc_eval||[]).map(p=>({x:p.t,y:p.winrate}));
    const pe2 = (g.ppo_eval||[]).map(p=>({x:p.t,y:p.winrate}));
    const ne = (g.dmc.at(-1)||{}).eps, pe=(g.ppo.at(-1)||{}).eps;
    return '<div class="card"><div class="row"><h2>'+g.title+'</h2>'+badge(g.phase)+'</div>'+
      '<div class="muted" style="font-size:12px">DMC '+(ne||0)+' eps · PPO '+(pe||0)+' eps</div>'+
      '<div class="charts">'+
        '<div class="chart" style="grid-column:1 / -1"><h3>win-rate vs random — <span style="color:#5aa9e0">DMC</span> / <span style="color:#69d98a">PPO</span> (higher = learning)</h3>'+chart2(de,'#5aa9e0',pe2,'#69d98a')+'</div>'+
        '<div class="chart"><h3>DMC loss (moving target ≠ quality)</h3>'+chart(dmc,'#5aa9e0',false)+'</div>'+
        '<div class="chart"><h3>PPO self-play win-rate (~0.5 by symmetry)</h3>'+chart(ppo,'#69d98a',true)+'</div>'+
      '</div>'+resTable(g.result)+'</div>';
  }).join('');
}
tick(); setInterval(tick, 3000);
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/metrics"):
            body = json.dumps(collect()).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            body = HTML.encode()
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


if __name__ == "__main__":
    print(f"♠# training dashboard on http://localhost:{PORT}  (logs: {LOGDIR})", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
