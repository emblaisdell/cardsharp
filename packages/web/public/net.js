// WebRTC peer networking for ♠# multiplayer (browser).
//
// Topology: a STAR around the host. Each non-host peer opens one RTCDataChannel
// to the host; the host relays broadcasts to the other peers. Signaling (SDP +
// ICE) goes through the matchmaking server (SSE + POST); once connected, game
// traffic flows peer-to-peer over the data channels — the server never sees it.
//
// The host is authoritative (it runs the engine). During play it uses directed
// messages: `sendTo(guest, …)` to push a guest its own observation / decision,
// and the guest replies with `sendHost(…)`. `broadcast` remains available for
// any all-peer message.

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export class Net {
  constructor({ base = "", room, onLog = () => {}, onPeers = () => {}, onData = () => {} }) {
    this.base = base;
    this.room = room;
    this.onLog = onLog;
    this.onPeers = onPeers; // (peers[], isHost)
    this.onData = onData; // (fromPeerId, payload)
    this.self = "p" + Math.random().toString(36).slice(2, 9);
    this.host = null;
    this.isHost = false;
    this.peers = [];
    this.conns = new Map(); // peerId -> { pc, ch }
    this.es = null;
  }

  join() {
    this.es = new EventSource(`${this.base}/events?room=${encodeURIComponent(this.room)}&peer=${this.self}`);
    this.es.onmessage = (e) => this.onSignal(JSON.parse(e.data));
    this.es.onerror = () => this.onLog("signaling connection error");
    this.onLog(`joining room "${this.room}" as ${this.self}…`);
  }

  close() {
    if (this.es) this.es.close();
    for (const { pc } of this.conns.values()) try { pc.close(); } catch {}
    this.conns.clear();
  }

  connectedPeers() {
    return [...this.conns.entries()].filter(([, c]) => c.ch && c.ch.readyState === "open").map(([p]) => p);
  }

  // ---- signaling ----
  async onSignal(msg) {
    if (msg.type === "welcome") {
      this.host = msg.host;
      this.isHost = msg.host === this.self;
      this.peers = msg.peers;
      this.onPeers(this.peers, this.isHost);
      // non-host peers initiate the connection to the host
      if (!this.isHost) this.makeConn(this.host, true);
      return;
    }
    if (msg.type === "peer-joined" || msg.type === "peer-left") {
      this.peers = msg.peers;
      this.onPeers(this.peers, this.isHost);
      return;
    }
    if (msg.type === "host") {
      this.host = msg.host;
      this.isHost = msg.host === this.self;
      this.onPeers(this.peers, this.isHost);
      return;
    }
    if (msg.type === "signal") {
      let c = this.conns.get(msg.from);
      if (!c) c = this.makeConn(msg.from, false); // host receiving a client's first offer
      const pc = c.pc;
      const p = msg.payload;
      if (p.sdp) {
        await pc.setRemoteDescription(p.sdp);
        if (p.sdp.type === "offer") {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this.sendSignal(msg.from, { sdp: pc.localDescription });
        }
      } else if (p.ice) {
        try { await pc.addIceCandidate(p.ice); } catch {}
      }
    }
  }

  sendSignal(to, payload) {
    fetch(`${this.base}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: this.room, from: this.self, to, payload }),
    });
  }

  // ---- WebRTC connections ----
  makeConn(peerId, initiator) {
    const pc = new RTCPeerConnection(ICE);
    const entry = { pc, ch: null };
    this.conns.set(peerId, entry);
    pc.onicecandidate = (e) => { if (e.candidate) this.sendSignal(peerId, { ice: e.candidate }); };
    if (initiator) {
      const ch = pc.createDataChannel("game");
      this.setupCh(peerId, ch);
      pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => this.sendSignal(peerId, { sdp: pc.localDescription }));
    } else {
      pc.ondatachannel = (e) => this.setupCh(peerId, e.channel);
    }
    return entry;
  }

  setupCh(peerId, ch) {
    const entry = this.conns.get(peerId);
    entry.ch = ch;
    ch.onopen = () => { this.onLog(`peer ${peerId} connected`); this.onPeers(this.peers, this.isHost); };
    ch.onclose = () => this.onPeers(this.peers, this.isHost);
    ch.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "bc") {
        // host relays a client's broadcast to the other peers (star hub)
        if (this.isHost) {
          for (const [pid, c] of this.conns) {
            if (pid !== peerId && c.ch && c.ch.readyState === "open") c.ch.send(e.data);
          }
        }
        this.onData(peerId, m.payload);
      } else if (m.t === "dm") {
        // directed message (host<->guest), not relayed
        this.onData(peerId, m.payload);
      }
    };
  }

  // directed send to one peer (used by the authoritative host <-> a guest)
  sendTo(peerId, payload) {
    const c = this.conns.get(peerId);
    if (c && c.ch && c.ch.readyState === "open") c.ch.send(JSON.stringify({ t: "dm", payload }));
  }
  // a guest sends to the host
  sendHost(payload) {
    this.sendTo(this.host, payload);
  }

  // send a payload to every other peer (relayed by the host in the star)
  broadcast(payload) {
    const data = JSON.stringify({ t: "bc", payload });
    if (this.isHost) {
      for (const { ch } of this.conns.values()) if (ch && ch.readyState === "open") ch.send(data);
    } else {
      const h = this.conns.get(this.host);
      if (h && h.ch && h.ch.readyState === "open") h.ch.send(data);
    }
  }
}
