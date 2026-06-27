# @cardsharp/web — static browser client

Play any ♠# game in the browser against random or ML bots. **Everything runs
client-side** — parsing, type-checking, the interpreter, and the ML policy. There
is no server-side game logic; the included server only serves static files.

## How it's built with zero dependencies

The `core` and `ml` packages are written in erasable TypeScript, so
[`build.mjs`](build.mjs) strips their types with Node's built-in
`stripTypeScriptTypes` and rewrites `.ts` import specifiers to `.js`, emitting
native ES modules into `public/lib/`. The browser loads them directly — no
esbuild, webpack, or `npm install`.

```bash
node packages/web/build.mjs     # transpile core+ml, copy games + models
node packages/web/serve.mjs     # serve public/ at http://localhost:8080
# or: npm --workspace @cardsharp/web run start
```

Then open the page, pick a game and player count, and play as **P1**. The board
shows every zone (cards hidden from you render as backs — the engine's
visibility model is honored), and your legal moves appear as buttons driven
directly by the engine's choice requests.

## How the UI maps to the engine

The human is just another `Controller`: its `choose(req, obs)` returns a Promise
that resolves when you click an option button ([app.js](public/app.js)). Bots are
`RandomController` / `MLController`. The engine drives them all identically — the
exact same loop the CLI and (later) the WebRTC peers use.

## Deploying

`public/` is fully static after a build — drop it on GitHub Pages, Netlify, S3,
or any static host. (The future WebRTC multiplayer keeps this property: only a
tiny signaling server is added, never game logic.)
