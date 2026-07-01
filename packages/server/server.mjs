// ♠# matchmaking + WebRTC signaling server (zero dependencies).
//
// This server has NO game logic. It does exactly two things:
//   1. serves the static web client (so multiplayer is same-origin — no CORS),
//   2. relays WebRTC signaling between peers in a room and tracks membership,
//      electing the first peer as "host".
// Gameplay runs peer-to-peer over WebRTC data channels. The HOST is authoritative:
// it alone runs the engine and holds the full state (and runs all bots). Guests
// are thin clients — they receive only their own masked observation and their own
// decisions, and reply with a move; hidden cards never leave the host. Signaling
// uses Server-Sent Events (server→peer) + POST (peer→server) — no WebSocket lib.
//
//   node packages/server/server.mjs [port]   # default 8090

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pub = join(dirname(fileURLToPath(import.meta.url)), "../web/public");
const port = Number(process.argv[2] || 8090);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".card": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

// rooms: id -> Map(peerId -> { res, host })
const rooms = new Map();

function roomPeers(room) {
  return [...(rooms.get(room)?.keys() ?? [])];
}
function sendTo(room, peer, msg) {
  const r = rooms.get(room);
  const entry = r?.get(peer);
  if (entry) entry.res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
function broadcast(room, msg, exceptPeer) {
  for (const [pid, entry] of rooms.get(room) ?? []) {
    if (pid !== exceptPeer) entry.res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }
}
function hostOf(room) {
  const r = rooms.get(room);
  for (const [pid, e] of r ?? []) if (e.host) return pid;
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- SSE signaling stream: a peer joins a room ----
  if (url.pathname === "/events") {
    const room = url.searchParams.get("room") || "lobby";
    const peer = url.searchParams.get("peer");
    if (!peer) { res.writeHead(400).end("peer required"); return; }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (!rooms.has(room)) rooms.set(room, new Map());
    const r = rooms.get(room);
    const isHost = r.size === 0; // first peer hosts
    r.set(peer, { res, host: isHost });
    // tell the newcomer who's here and who hosts; tell others someone joined
    sendTo(room, peer, { type: "welcome", self: peer, host: hostOf(room), peers: roomPeers(room) });
    broadcast(room, { type: "peer-joined", peer, peers: roomPeers(room) }, peer);

    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      r.delete(peer);
      let hostChanged = false;
      if (r.size > 0 && !hostOf(room)) {
        const first = r.keys().next().value;
        (r.get(first)).host = true;
        hostChanged = true;
      }
      broadcast(room, { type: "peer-left", peer, peers: roomPeers(room) });
      if (hostChanged) broadcast(room, { type: "host", host: hostOf(room) });
      if (r.size === 0) rooms.delete(room);
    });
    return;
  }

  // ---- relay a signaling message peer -> peer (WebRTC SDP / ICE, or game meta) ----
  if (url.pathname === "/signal" && req.method === "POST") {
    const msg = JSON.parse((await readBody(req)) || "{}");
    const { room, to, from } = msg;
    const out = { type: "signal", from, payload: msg.payload };
    if (to) sendTo(room, to, out);
    else broadcast(room, out, from); // broadcast to everyone but the sender
    res.writeHead(204).end();
    return;
  }

  // ---- otherwise serve the static client ----
  try {
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    const file = normalize(join(pub, p));
    if (!file.startsWith(pub)) { res.writeHead(403).end("forbidden"); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, () => {
  console.log(`♠# multiplayer server on http://localhost:${port}`);
  console.log(`  serves the static client AND WebRTC signaling (no game logic).`);
  console.log(`  open two tabs, create a room in one, join with its code in the other.`);
});
