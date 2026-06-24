// Static browser client for Card#. The engine, type checker and ML players all
// run here in the browser; this file just wires the choice model to the DOM:
// the human is one Controller whose choose() returns a Promise resolved by a
// button click, and the opponents are RandomController / MLController.

import { compile, runGame, RandomController, Card, Player } from "./lib/core/index.js";
import { LinearPolicy, MLController } from "./lib/ml/index.js";

const SUIT = ["♣", "♦", "♥", "♠"];
const RANK = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const $ = (id) => document.getElementById(id);
const gameSel = $("game");
const playersSel = $("players");
const oppSel = $("opponents");
const boardEl = $("board");
const controlsEl = $("controls");
const logEl = $("log");
const statusEl = $("status");

let humanResolve = null;
const modelCache = new Map();
let lastObs = null; // last observation, for re-rendering on expand/collapse
const expanded = new Set(); // zone keys the user has expanded

// ---------- a human player ----------
class HumanController {
  choose(req, obs) {
    renderBoard(obs);
    return new Promise((resolve) => {
      humanResolve = resolve;
      renderControls(req, obs);
    });
  }
}

// ---------- rendering ----------
function cardEl(c, hidden) {
  const d = document.createElement("div");
  if (hidden || !c) {
    d.className = "card back";
    return d;
  }
  d.className = "card" + (c.suit === 1 || c.suit === 2 ? " red" : "");
  d.textContent = RANK[c.rank] + SUIT[c.suit];
  return d;
}

function renderBoard(obs) {
  lastObs = obs;
  boardEl.innerHTML = "";
  // shared zones first
  const shared = [];
  const perPlayer = [];
  for (const [name, v] of Object.entries(obs.zones)) {
    if (Array.isArray(v)) perPlayer.push([name, v]);
    else shared.push([name, v]);
  }
  if (shared.length) {
    const panel = document.createElement("div");
    panel.className = "player";
    panel.innerHTML = `<div class="pname">Table</div>`;
    for (const [name, view] of shared) panel.appendChild(zoneRow(name, view, "shared:" + name));
    boardEl.appendChild(panel);
  }
  for (const p of obs.players) {
    const panel = document.createElement("div");
    panel.className =
      "player" +
      (p.id === obs.current ? " turn" : "") +
      (p.id === obs.viewer ? " you" : "") +
      (p.out ? " out" : "");
    panel.innerHTML = `<div class="pname">${p.name}` +
      `${p.id === obs.viewer ? '<span class="tag">you</span>' : ""}` +
      `${p.id === obs.current ? '<span class="tag">to act</span>' : ""}` +
      `${p.out ? '<span class="tag">out</span>' : ""}</div>`;
    for (const [name, arr] of perPlayer) panel.appendChild(zoneRow(name, arr[p.id], p.id + ":" + name));
    boardEl.appendChild(panel);
  }
}

function zoneRow(name, view, key) {
  const row = document.createElement("div");
  row.className = "zone";
  const label = document.createElement("span");
  label.className = "zname";
  label.textContent = name;
  row.appendChild(label);
  const cards = document.createElement("div");
  cards.className = "cards";

  const hidden = view.size > 0 && view.cards.every((c) => c === null);
  if (view.size === 0) {
    const empty = document.createElement("span");
    empty.className = "count";
    empty.textContent = "—";
    cards.appendChild(empty);
  } else if (hidden) {
    // a private hand fans out to its real size; a face-down pile is a tight
    // stack with a ×N marker
    cards.appendChild(view.layout === "hand" ? fanEl(view.size) : stackEl(view.size, true));
  } else if (view.layout === "pile") {
    // visible pile: top card + stack, expandable on click
    cards.appendChild(visiblePile(view, key));
  } else {
    // hand / spread: every card laid out face up
    for (const c of view.cards) cards.appendChild(cardEl(c, c === null));
  }
  row.appendChild(cards);
  return row;
}

// a face-down pile: a few overlapping backs + a ×N count badge
function stackEl(size, faceDown) {
  const wrap = document.createElement("div");
  wrap.className = "stack-wrap";
  const stack = document.createElement("div");
  stack.className = "stack";
  const shown = Math.min(size, 5);
  for (let i = 0; i < shown; i++) stack.appendChild(cardEl(null, faceDown));
  wrap.appendChild(stack);
  wrap.appendChild(badge("×" + size));
  return wrap;
}

// a private (hidden) hand: a tight fan of one back per card, so the size shows
function fanEl(size) {
  const wrap = document.createElement("div");
  wrap.className = "stack-wrap";
  const fan = document.createElement("div");
  fan.className = "stack fan";
  const shown = Math.min(size, 13);
  for (let i = 0; i < shown; i++) fan.appendChild(cardEl(null, true));
  wrap.appendChild(fan);
  if (size > shown) wrap.appendChild(badge("×" + size));
  return wrap;
}

// a visible pile: collapsed shows the top card with depth behind it + ×N and
// expands to the full contents on click.
function visiblePile(view, key) {
  const open = expanded.has(key);
  const wrap = document.createElement("div");
  wrap.className = "stack-wrap pile-toggle";
  wrap.title = open ? "click to collapse" : "click to expand";

  if (open) {
    const all = document.createElement("div");
    all.className = "cards";
    for (const c of view.cards) all.appendChild(cardEl(c, c === null));
    wrap.appendChild(all);
    wrap.appendChild(badge("×" + view.size + " ▾"));
  } else {
    const stack = document.createElement("div");
    stack.className = "stack";
    const depth = Math.min(view.size, 4);
    for (let i = depth - 1; i >= 0; i--) stack.appendChild(cardEl(view.cards[i], view.cards[i] === null));
    wrap.appendChild(stack);
    wrap.appendChild(badge("×" + view.size + (view.size > 1 ? " ▸" : "")));
  }

  wrap.onclick = () => {
    if (open) expanded.delete(key);
    else expanded.add(key);
    if (lastObs) renderBoard(lastObs);
  };
  return wrap;
}

function badge(text) {
  const b = document.createElement("span");
  b.className = "count";
  b.textContent = text;
  return b;
}

function renderControls(req, obs) {
  controlsEl.innerHTML = "";
  const prompt = document.createElement("div");
  prompt.className = "prompt";
  prompt.textContent = req.prompt || `Choose (${req.kind})`;
  controlsEl.appendChild(prompt);

  const opts = document.createElement("div");
  opts.className = "opts";

  if (req.kind === "cards") {
    renderCardsPicker(req, opts);
    controlsEl.appendChild(opts);
    return;
  }

  req.options.forEach((o) => {
    const b = document.createElement("button");
    b.appendChild(optionLabel(o, req.kind));
    b.onclick = () => answer(o);
    opts.appendChild(b);
  });
  // Option<...>-style choice: allow declining without a separate boolean
  if (req.allowNone) {
    const pass = document.createElement("button");
    pass.textContent = "Stop / Pass";
    pass.className = "pass";
    pass.onclick = () => answer(null);
    opts.appendChild(pass);
  }
  controlsEl.appendChild(opts);
}

function optionLabel(o, kind) {
  const span = document.createElement("span");
  if (o instanceof Card) {
    span.className = "meld";
    span.appendChild(cardEl(o, false));
  } else if (o instanceof Player) {
    span.textContent = o.name;
  } else if (Array.isArray(o)) {
    if (o.length === 0) span.textContent = "Done";
    else {
      span.className = "meld";
      o.forEach((c) => {
        const m = cardEl(c, false);
        m.classList.add("mini");
        span.appendChild(m);
      });
    }
  } else if (typeof o === "boolean") {
    span.textContent = o ? "Yes" : "No";
  } else if (kind === "rank") {
    span.textContent = RANK[o] ?? String(o);
  } else if (kind === "suit") {
    span.textContent = SUIT[o] ?? String(o);
  } else {
    span.textContent = String(o);
  }
  return span;
}

function renderCardsPicker(req, opts) {
  const picked = new Set();
  const min = req.min ?? 0;
  const max = req.max ?? req.options.length;
  req.options.forEach((c, i) => {
    const b = document.createElement("button");
    b.appendChild(optionLabel(c, "card"));
    b.onclick = () => {
      if (picked.has(i)) picked.delete(i);
      else if (picked.size < max) picked.add(i);
      b.style.outline = picked.has(i) ? "2px solid var(--accent)" : "";
      submit.disabled = picked.size < min;
    };
    opts.appendChild(b);
  });
  const submit = document.createElement("button");
  submit.textContent = `Play ${min}-${max}`;
  submit.disabled = min > 0;
  submit.onclick = () => answer([...picked].map((i) => req.options[i]));
  opts.appendChild(submit);
}

function answer(value) {
  controlsEl.innerHTML = "";
  const r = humanResolve;
  humanResolve = null;
  if (r) r(value);
}

// ---------- logging ----------
function log(msg, cls) {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.textContent = msg;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
}

function describeChoice(req, ans) {
  const who = req.player.name;
  if (ans === null) return `${who}: stops`;
  if (ans instanceof Card) return `${who}: ${RANK[ans.rank]}${SUIT[ans.suit]}`;
  if (ans instanceof Player) return `${who} → ${ans.name}`;
  if (typeof ans === "boolean") return `${who}: ${req.prompt || "?"} ${ans ? "yes" : "no"}`;
  if (Array.isArray(ans)) return `${who}: ${ans.length ? ans.map((c) => RANK[c.rank] + SUIT[c.suit]).join(" ") : "done"}`;
  if (req.kind === "rank") return `${who}: asks ${RANK[ans] ?? ans}`;
  return `${who}: ${ans}`;
}

// ---------- model loading ----------
async function loadModel(file) {
  if (modelCache.has(file)) return modelCache.get(file);
  const name = file.replace(/\.card$/, "");
  try {
    const m = await fetch(`models/${name}.json`).then((r) => (r.ok ? r.json() : null));
    const policy = m ? LinearPolicy.fromJSON(m) : null;
    modelCache.set(file, policy);
    return policy;
  } catch {
    modelCache.set(file, null);
    return null;
  }
}

// ---------- game lifecycle ----------
async function startGame() {
  const file = gameSel.value;
  const src = await fetch(`games/${file}`).then((r) => r.text());
  let program;
  try {
    program = compile(src); // parses + type-checks in the browser
  } catch (e) {
    statusEl.textContent = "compile error: " + e.message;
    return;
  }
  const seats = Number(playersSel.value);
  let mlPolicy = null;
  if (oppSel.value === "ml") mlPolicy = await loadModel(file);

  const controllers = [];
  for (let s = 0; s < seats; s++) {
    if (s === 0) controllers.push(new HumanController());
    else if (mlPolicy) controllers.push(new MLController(mlPolicy, { temperature: 0 }));
    else controllers.push(new RandomController(1000 + s * 7 + (Date.now() & 1023)));
  }

  logEl.innerHTML = "";
  boardEl.innerHTML = "";
  controlsEl.innerHTML = "";
  const oppLabel = mlPolicy ? "ML bots" : oppSel.value === "ml" ? "random bots (no model)" : "random bots";
  statusEl.textContent = `${program.name}: you are P1 vs ${seats - 1} ${oppLabel}`;
  log(`New game of ${program.name} — ${seats} players`);

  try {
    const res = await runGame(program, controllers, {
      players: seats,
      seed: Date.now() % 100000,
      quiet: true,
      onChoice: (req, _obs, ans) => log(describeChoice(req, ans)),
    });
    renderBoard(res.state.observe(res.state.players[0]));
    const names = res.winners.length ? res.winners.map((p) => p.name).join(", ") : "nobody";
    statusEl.textContent = `${program.name} over — winner: ${names}`;
    log(`Winner: ${names}`, "win");
  } catch (e) {
    statusEl.textContent = "error: " + e.message;
    log("error: " + e.message);
  }
}

// ---------- init ----------
async function init() {
  const games = await fetch("games/index.json").then((r) => r.json());
  for (const f of games) {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f.replace(/\.card$/, "");
    gameSel.appendChild(o);
  }
  syncPlayerOptions();
  gameSel.onchange = syncPlayerOptions;
  $("new").onclick = startGame;
}

// populate the players dropdown from the chosen game's `players` range
async function syncPlayerOptions() {
  const src = await fetch(`games/${gameSel.value}`).then((r) => r.text());
  const m = src.match(/players\s+(\d+)(?:\s*\.\.\s*(\d+))?/);
  const min = m ? Number(m[1]) : 2;
  const max = m && m[2] ? Number(m[2]) : min;
  playersSel.innerHTML = "";
  for (let n = min; n <= max; n++) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = `${n} players`;
    playersSel.appendChild(o);
  }
}

init();
