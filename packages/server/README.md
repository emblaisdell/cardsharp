# @cardsharp/server — matchmaking + WebRTC signaling

A tiny, **zero-dependency** server with **no game logic**. It does only two
things:

1. **serves the static client** (so multiplayer is same-origin — no CORS), and
2. **relays WebRTC signaling** between peers in a room and tracks membership,
   electing the first peer as **host**.

Gameplay runs **peer-to-peer over WebRTC data channels** with an **authoritative
host**: the host alone runs the engine, holds the full game state, and runs all
bots. Guests are thin clients — they receive only their **own masked
observation** and the options for their **own decisions**, and reply with a move.
Hidden cards never leave the host. None of this touches this server.

## Run it

```bash
node packages/server/server.mjs            # port 8090
node packages/server/server.mjs 9000       # custom port
```

Then open **two browser tabs** at `http://localhost:<port>`:

1. In tab 1, type a room code (e.g. `table7`) and click **Create / Join room** —
   you become the **host**.
2. In tab 2, enter the **same code** and **Create / Join room**.
3. When the status shows the peers connected, the host picks a game + player
   count and clicks **Start game (host)**.

The host now runs the game; each of you controls your own seat (P1, P2, …) and
sees only *your* information (the host sends each guest just their masked view).
Extra seats (if the game needs more players than there are peers) are filled by
**host-run bots**.

## How it works

- **Signaling transport**: Server-Sent Events (server→peer) + `POST /signal`
  (peer→server). No WebSocket library needed.
  - `GET /events?room=R&peer=P` — SSE stream; joins room `R`, emits `welcome`,
    `peer-joined`, `peer-left`, `host` events.
  - `POST /signal` `{room, from, to, payload}` — relays a peer's SDP/ICE to
    another peer (or broadcasts if `to` is omitted).
- **Topology**: a star around the host (`packages/web/public/net.js`). Each guest
  opens one `RTCDataChannel` to the host (directed host↔guest messages).
- **Authoritative loop** (`packages/web/public/app.js`): the host runs the
  resumable `Machine`. At each decision it sends the acting *guest* its own
  observation + that decision's options and awaits a move index; it answers its
  own seat from the UI and **runs every bot seat itself**. After each move it
  pushes each guest their refreshed masked observation. Guests hold no engine and
  no hidden state.

## Caveats

- **Trust the host.** Because the host is authoritative it sees the full state
  (it has to, to run the game) — so the host could cheat. Guests cannot: they
  only ever receive their own masked view. This is the standard authoritative
  trade-off; a fully trustless variant would need commit-reveal / mental-poker
  dealing.
- Over the open internet you may need a TURN server for NAT traversal; on a LAN /
  localhost the bundled STUN config is enough.
