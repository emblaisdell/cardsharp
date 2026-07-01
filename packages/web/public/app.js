// Static browser client for ♠#. The engine, type checker and ML players all
// run here in the browser; this file just wires the choice model to the DOM:
// the human's choice is a Promise resolved by a button click; opponents are
// random / ML / fair-IS-MCTS, all driven on the resumable Machine.

import { compile, GameState, RNG, Machine, Card, Player, Labeled } from "./lib/core/index.js";
import { LinearPolicy, MLController, ismctsAction, NetPlayer, neuralIsmctsAction } from "./lib/ml/index.js";
import { Net } from "./net.js";

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
// renders the board + controls and resolves when the player clicks an option
function humanChoose(req, obs) {
  renderBoard(obs);
  const forced = forcedAnswer(req);
  if (forced !== undefined) return Promise.resolve(forced);
  return new Promise((resolve) => {
    humanResolve = resolve;
    renderControls(req, obs);
  });
}

// If a choice request leaves the player no real decision (a single legal
// option), return that option; otherwise return undefined so the controls show.
function forcedAnswer(req) {
  if (req.options.length === 1) return req.options[0];
  return undefined;
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
  prompt.textContent = req.prompt || "Choose";
  controlsEl.appendChild(prompt);

  const opts = document.createElement("div");
  opts.className = "opts";

  // Every option renders from its own runtime value; a `null` option is the
  // decline button. The engine returns the chosen value (unwrapping `labeled`).
  req.options.forEach((o) => {
    const b = document.createElement("button");
    if (o === null) b.className = "pass";
    b.appendChild(optionLabel(o));
    b.onclick = () => answer(o);
    opts.appendChild(b);
  });
  controlsEl.appendChild(opts);
}

function optionLabel(o) {
  const span = document.createElement("span");
  if (o instanceof Labeled) {
    // a value paired with an explicit display string
    span.textContent = o.text;
  } else if (o === null) {
    span.textContent = "None";
  } else if (o instanceof Card) {
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
  } else {
    span.textContent = String(o);
  }
  return span;
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
  logEl.insertBefore(li, logEl.firstChild);
  logEl.scrollTop = 0;
}

function describeChoice(req, ans) {
  const who = req.player.name;
  if (ans instanceof Labeled) return `${who}: ${ans.text}`;
  if (ans === null) return `${who}: stops`;
  if (ans instanceof Card) return `${who}: ${RANK[ans.rank]}${SUIT[ans.suit]}`;
  if (ans instanceof Player) return `${who} → ${ans.name}`;
  if (typeof ans === "boolean") return `${who}: ${req.prompt || "?"} ${ans ? "yes" : "no"}`;
  if (Array.isArray(ans)) return `${who}: ${ans.length ? ans.map((c) => RANK[c.rank] + SUIT[c.suit]).join(" ") : "done"}`;
  return `${who}: ${ans}`;
}

// ---------- model loading ----------
// Returns { policy, meta } for a game's trained ML model, or null if none exists.
async function getModel(file) {
  if (modelCache.has(file)) return modelCache.get(file);
  const name = file.replace(/\.card$/, "");
  let entry = null;
  try {
    const m = await fetch(`models/${name}.json`).then((r) => (r.ok ? r.json() : null));
    if (m && Array.isArray(m.weights)) entry = { policy: LinearPolicy.fromJSON(m), meta: m };
  } catch {
    entry = null;
  }
  modelCache.set(file, entry);
  return entry;
}

// Returns a NetPlayer for the game's trained DMC net, or null. Used as the
// policy-prior + value for the hybrid Neural-IS-MCTS bot.
const netCache = new Map();
async function getNet(file) {
  if (netCache.has(file)) return netCache.get(file);
  const name = file.replace(/\.card$/, "");
  let net = null;
  try {
    const j = await fetch(`models/py/${name}_dmc.netjson`).then((r) => (r.ok ? r.json() : null));
    if (j && j.trunk0_w) net = NetPlayer.fromJSON(j);
  } catch {
    net = null;
  }
  netCache.set(file, net);
  return net;
}

// Rebuild the Opponents dropdown to show exactly which bot types this game can be
// played against: Random always; ML only when a model is trained for it. (MCTS
// is a perfect-information benchmark baseline, not a fair playable bot, so it's
// not offered here.)
async function syncOpponents() {
  const file = gameSel.value;
  const prev = oppSel.value;
  const [model, net] = await Promise.all([getModel(file), getNet(file)]);
  oppSel.innerHTML = "";
  oppSel.add(new Option("Random bots", "random"));
  if (model) {
    const g = (model.meta.trainedGames ?? 0).toLocaleString();
    oppSel.add(new Option(`ML bot — linear policy (${g}-game model)`, "ml"));
  } else {
    const o = new Option("ML bot — not trained for this game", "ml");
    o.disabled = true;
    oppSel.add(o);
  }
  // Fair IS-MCTS works on ANY game with no training (it searches), so it's
  // always offered. It's the only search bot exposed here — the perfect-info
  // MCTS is benchmark-only because it sees hidden cards.
  oppSel.add(new Option("Fair IS-MCTS — information-set search (no training)", "ismcts"));
  // Hybrid: Neural-IS-MCTS uses the trained net as a PUCT prior over the same
  // fair search (offered only when a net exists for this game).
  if (net) {
    oppSel.add(new Option("Neural IS-MCTS (hybrid) — net-guided fair search", "hybrid"));
  } else {
    const o = new Option("Neural IS-MCTS (hybrid) — no net for this game", "hybrid");
    o.disabled = true;
    oppSel.add(o);
  }

  oppSel.value =
    (prev === "ml" && model) || prev === "ismcts" || (prev === "hybrid" && net) ? prev : "random";
  oppNote.textContent = model
    ? `Playable: Random ✓ · ML ✓ · Fair IS-MCTS ✓ · Neural-IS-MCTS ${net ? "✓ (hybrid)" : "✗"}.`
    : `Playable: Random ✓ · ML ✗ · Fair IS-MCTS ✓ · Neural-IS-MCTS ${net ? "✓ (hybrid)" : "✗"}.`;
  oppNote.className = model || net ? "opp-note ok" : "opp-note warn";
}

// ---------- game lifecycle ----------
// The browser drives games on the resumable Machine. You are seat 0 (the human);
// each opponent seat is a random / ML / fair-IS-MCTS bot. Driving on the Machine
// is what lets IS-MCTS clone the live position to search.
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
  const oppType = oppSel.value; // 'random' | 'ml' | 'ismcts' | 'hybrid'
  let mlPolicy = null;
  if (oppType === "ml") {
    const model = await getModel(file);
    mlPolicy = model ? model.policy : null;
  }
  let net = null;
  if (oppType === "hybrid") net = await getNet(file);

  const rng = new RNG((Date.now() & 0xffffff) | 1);
  const ml = mlPolicy ? new MLController(mlPolicy, { temperature: 0 }) : null;
  const oppLabel =
    oppType === "hybrid" ? "Neural-IS-MCTS bots"
      : oppType === "ismcts" ? "fair IS-MCTS bots"
        : ml ? "ML bots" : "random bots";

  logEl.innerHTML = "";
  boardEl.innerHTML = "";
  controlsEl.innerHTML = "";
  statusEl.textContent = `${program.name}: you are P1 vs ${seats - 1} ${oppLabel}`;
  log(`New game of ${program.name} — ${seats} players`);

  // bot decision for a non-human seat
  const botChoose = (machine, req, obs) => {
    if (oppType === "hybrid" && net)
      return neuralIsmctsAction(machine, req.player.id, net, { iterations: 80, leaf: "rollout", rolloutDepth: 25 }, rng);
    if (oppType === "ismcts") return ismctsAction(machine, req.player.id, { iterations: 80, rolloutDepth: 25 }, rng);
    if (ml) return ml.choose(req, obs);
    return req.options.length ? req.options[rng.int(req.options.length)] : null;
  };

  try {
    const machine = new Machine(program, new GameState(seats, Date.now() % 100000), () => {
      throw new Error("vm decide unused");
    });
    machine.state.onAnnounce = (msg) => log(msg, "event");
    let r = machine.start();
    while (!r.done) {
      const req = r.request;
      const obs = machine.state.observe(req.player);
      let answer;
      if (req.player.id === 0) {
        answer = await humanChoose(req, obs);
      } else {
        // yield to the browser so the board paints before a slow bot thinks
        await new Promise((res) => setTimeout(res, oppType === "ismcts" || oppType === "hybrid" ? 20 : 0));
        answer = botChoose(machine, req, obs);
      }
      log(describeChoice(req, answer));
      machine.supply(answer);
      r = machine.next();
    }
    renderBoard(machine.state.observe(machine.state.players[0]));
    const names = r.winners.length ? r.winners.map((p) => p.name).join(", ") : "nobody";
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
  syncOpponents();
  gameSel.onchange = () => {
    syncPlayerOptions();
    syncOpponents();
  };
  $("new").onclick = startGame;
}

// a small note under the Opponents selector showing per-game availability
const oppNote = document.createElement("div");
oppNote.className = "opp-note";
oppSel.parentElement.appendChild(oppNote);

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

// =====================================================================
// Multiplayer (WebRTC P2P, deterministic lockstep)
// =====================================================================
// Every peer runs the same Machine from a shared seed; at each decision exactly
// AUTHORITATIVE HOST: only the host runs the engine and holds the full state.
// Guests are thin clients — they receive only their OWN masked observation and
// the options for their OWN decisions, and reply with a move index. Hidden cards
// never leave the host, so a guest's client cannot see them. The server only
// does matchmaking + signaling.

let net = null;
const guestMovePending = new Map(); // peerId -> resolver (host awaiting a guest move)

function buildMpUI() {
  const wrap = document.createElement("section");
  wrap.className = "setup mp";
  wrap.innerHTML = `
    <label>Room code <input id="mpRoom" placeholder="e.g. table7" style="width:120px"></label>
    <button id="mpJoin">Create / Join room</button>
    <button id="mpStart" disabled>Start game (host)</button>
    <button id="mpLeave" disabled>Leave</button>
    <span id="mpStatus" class="status"></span>`;
  document.querySelector("main").before(wrap);

  const roomEl = $("mpRoom");
  const joinBtn = $("mpJoin");
  const startBtn = $("mpStart");
  const leaveBtn = $("mpLeave");
  const mpStatus = $("mpStatus");

  const refresh = (peers, isHost) => {
    const conn = net ? net.connectedPeers().length : 0;
    mpStatus.textContent = `room "${net?.room}" — ${peers.length} peer(s), ${conn} connected · you are ${isHost ? "HOST" : "guest"} (${net?.self})`;
    startBtn.disabled = !(isHost && peers.length >= 2);
  };

  joinBtn.onclick = () => {
    const room = (roomEl.value || "table").trim();
    net = new Net({
      base: "",
      room,
      onLog: (m) => log("[net] " + m),
      onPeers: refresh,
      onData: onNetData,
    });
    net.join();
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    mpStatus.textContent = `joining "${room}"…`;
  };
  leaveBtn.onclick = () => {
    if (net) net.close();
    net = null;
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
    startBtn.disabled = true;
    mpStatus.textContent = "left room";
  };
  startBtn.onclick = () => hostStart();
}

function onNetData(from, payload) {
  if (net && net.isHost) {
    // host: the only thing a guest sends is its chosen move index
    if (payload.type === "move") {
      const res = guestMovePending.get(from);
      if (res) { guestMovePending.delete(from); res(payload.index); }
    }
    return;
  }
  // guest: react to the host's authoritative messages (no engine here)
  switch (payload.type) {
    case "start": guestStatus(payload); break;
    case "obs": renderBoard(payload.obs); break;
    case "choose": renderGuestChoose(payload); break;
    case "log": log(payload.msg, payload.cls); break;
    case "over":
      if (payload.obs) renderBoard(payload.obs);
      statusEl.textContent = `${payload.game} over — winner: ${payload.winners || "nobody"}`;
      log(`Winner: ${payload.winners || "nobody"}`, "win");
      break;
  }
}

function guestStatus(msg) {
  logEl.innerHTML = "";
  controlsEl.innerHTML = "";
  statusEl.textContent = `${msg.game.replace(/\.card$/, "")}: you are P${msg.seat + 1} (guest)`;
  log(`Joined ${msg.game.replace(/\.card$/, "")} as P${msg.seat + 1}; host controls the deck.`);
}

// HOST: assemble the match, tell each guest its seat, then run the engine.
async function hostStart() {
  if (!net || !net.isHost) return;
  const file = gameSel.value;
  const src = await fetch(`games/${file}`).then((r) => r.text());
  const program = compile(src);
  const range = program.sections.find((s) => s.type === "PlayersDecl") || { min: 2, max: 6 };
  const guests = net.connectedPeers().sort();
  const peers = [net.self, ...guests]; // host is seat 0
  if (peers.length > range.max) { log(`too many players for ${file} (max ${range.max})`); return; }
  const seats = Math.max(range.min, peers.length);
  const assignment = [];
  for (let s = 0; s < seats; s++) assignment.push(s < peers.length ? peers[s] : "bot");
  // tell each guest only its own seat + the game name
  for (const g of guests) net.sendTo(g, { type: "start", game: file, seat: assignment.indexOf(g) });
  runAuthoritativeGame(program, file, seats, (Date.now() % 100000) + 1, assignment).catch((e) => log("host error: " + e.message));
}

// HOST-ONLY: the authoritative game loop. Runs the engine and ALL bots; sends
// each guest only its own masked observation and its own decisions.
async function runAuthoritativeGame(program, file, seats, seed, assignment) {
  const guestSeats = assignment.map((a, s) => ({ a, s })).filter((x) => x.a !== net.self && x.a !== "bot");
  const rng = new RNG(seed * 7 + 1); // host RNG for bot seats
  const mySeat = assignment.indexOf(net.self);

  logEl.innerHTML = "";
  controlsEl.innerHTML = "";
  log(`Hosting ${program.name}: ${seats} seats — ${assignment.map((a, i) => `P${i + 1}:${a === net.self ? "you" : a}`).join(", ")}`);

  const machine = new Machine(program, new GameState(seats, seed), () => { throw new Error("vm decide unused"); });
  const broadcastLog = (msg, cls) => { log(msg, cls); for (const { a } of guestSeats) net.sendTo(a, { type: "log", msg, cls }); };
  machine.state.onAnnounce = (m) => broadcastLog(m, "event");

  const pushObs = () => {
    renderBoard(machine.state.observe(machine.state.players[mySeat]));
    for (const { a, s } of guestSeats) net.sendTo(a, { type: "obs", obs: machine.state.observe(machine.state.players[s]) });
  };

  let r = machine.start();
  while (!r.done) {
    const req = r.request;
    const seat = req.player.id;
    const owner = assignment[seat];
    pushObs();
    let index;
    if (owner === net.self) {
      const chosen = await humanChoose(req, machine.state.observe(req.player));
      index = req.options.indexOf(chosen);
      if (index < 0) index = 0;
    } else if (owner === "bot") {
      // host runs all bots (random; IS-MCTS could be slotted in here)
      index = rng.int(req.options.length);
    } else {
      // a guest's decision: send THEM their options + observation, await reply
      statusEl.textContent = `waiting for P${seat + 1}…`;
      net.sendTo(owner, {
        type: "choose",
        prompt: req.prompt,
        options: req.options.map(serializeOption),
        obs: machine.state.observe(req.player),
      });
      index = await new Promise((resolve) => guestMovePending.set(owner, resolve));
      if (typeof index !== "number" || index < 0 || index >= req.options.length) index = 0;
    }
    broadcastLog(describeChoice(req, req.options[index]));
    machine.supply(req.options[index]);
    r = machine.next();
  }
  const names = r.winners.length ? r.winners.map((p) => p.name).join(", ") : "nobody";
  renderBoard(machine.state.observe(machine.state.players[mySeat]));
  statusEl.textContent = `${program.name} over — winner: ${names}`;
  log(`Winner: ${names}`, "win");
  for (const { a, s } of guestSeats) net.sendTo(a, { type: "over", game: file, winners: names, obs: machine.state.observe(machine.state.players[s]) });
}

// serialize one option to a renderable descriptor (no hidden ids leaked)
function serializeOption(o) {
  if (o instanceof Labeled) return { k: "labeled", text: o.text };
  if (o === null) return { k: "none" };
  if (o instanceof Card) return { k: "card", rank: o.rank, suit: o.suit };
  if (o instanceof Player) return { k: "player", name: o.name };
  if (Array.isArray(o)) return { k: "list", cards: o.map((c) => (c instanceof Card ? { rank: c.rank, suit: c.suit } : null)) };
  if (typeof o === "boolean") return { k: "bool", v: o };
  return { k: "scalar", v: o };
}

// GUEST: render the host-sent options as buttons; reply with the chosen index.
function renderGuestChoose(msg) {
  controlsEl.innerHTML = "";
  const prompt = document.createElement("div");
  prompt.className = "prompt";
  prompt.textContent = msg.prompt || "Choose";
  controlsEl.appendChild(prompt);
  const opts = document.createElement("div");
  opts.className = "opts";
  msg.options.forEach((d, i) => {
    const b = document.createElement("button");
    b.appendChild(descriptorLabel(d));
    b.onclick = () => { controlsEl.innerHTML = ""; net.sendHost({ type: "move", index: i }); };
    opts.appendChild(b);
  });
  controlsEl.appendChild(opts);
}

function descriptorLabel(d) {
  const span = document.createElement("span");
  if (d.k === "labeled") span.textContent = d.text;
  else if (d.k === "none") span.textContent = "None";
  else if (d.k === "card") { span.className = "meld"; span.appendChild(cardEl({ rank: d.rank, suit: d.suit }, false)); }
  else if (d.k === "player") span.textContent = d.name;
  else if (d.k === "list") {
    if (!d.cards.length) span.textContent = "Done";
    else { span.className = "meld"; d.cards.forEach((c) => { const m = cardEl(c, false); m.classList.add("mini"); span.appendChild(m); }); }
  } else if (d.k === "bool") span.textContent = d.v ? "Yes" : "No";
  else span.textContent = String(d.v);
  return span;
}

buildMpUI();
