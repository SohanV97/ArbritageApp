# Running arb-web

Two processes. The **engine** trades; **Next** only draws the screen.

```bash
npm run engine     # terminal 1 — the trading engine, on 127.0.0.1:4311
npm run dev        # terminal 2 — the UI, on localhost:3000
```

Open http://localhost:3000. If the engine is not running the page still loads and shows
**ENGINE DISCONNECTED** with the last prices it saw; it reconnects on its own when the engine
comes back.

## Why two processes

The engine used to live inside a Next.js route, which meant the loop deciding trades shared a
heap with page rendering and hot-reloading. That was not a tidiness problem:

- a trivial endpoint measured **2.2–3.6s** while the process GC-thrashed to **5.4 GB**, and a
  trade decided in that loop inherits the stall
- hot-reload dropped engine state and **silently killed the Kalshi feed** while the socket
  still looked connected
- editing the UI restarted the trading loop

Now you can restart the UI as often as you like without touching the engine.

## Stopping the engine

```bash
curl -X POST http://localhost:4311/shutdown
```

Ctrl+C in the engine's own terminal also works. **Nothing else does** — on Windows a signal
sent from another process terminates it without running the drain, and the drain is what
stops a half-executed trade being abandoned between the Polymarket fill and the Kalshi leg.

## Endpoints

| | |
|---|---|
| `GET /health` | engine state, feed health, build age, phase timings |
| `GET /stream` | SSE: `quotes` on every build, `ready` once a second. `?pairs=1` to include `pairsDetail` |
| `GET /snapshot` | one build as JSON. `?fresh=1` waits for a new one, `?pairs=1` includes pair detail |
| `GET /execute` | connection test against both venues |
| `POST /execute` | place a trade. `{ opportunity, amount, dryRun? }` |
| `GET/POST /autoexec` | auto-execute config and records |
| `GET /diag/books` | crossed-book check across every live book |
| `POST /shutdown` | drain and exit |

Bound to `127.0.0.1` on purpose: `POST /execute` has no authentication and spends real money.

## Environment

The engine reads `.env.local` itself via `server/loadEnv.ts`. Do **not** switch this to Node's
`--env-file`: it silently drops the multi-line `KALSHI_PRIVATE_KEY`, which fails every Kalshi
signature and the websocket feed, and looks like a credentials problem rather than a parser one.

| variable | default | |
|---|---|---|
| `ARB_ENGINE_PORT` | `4311` | engine port |
| `ARB_UI_ORIGIN` | `http://localhost:3000` | exact CORS origin allowed to trade |
| `ARB_TRADING_ENABLED` | enabled | set `false` for a read-only engine |
| `NEXT_PUBLIC_ENGINE_URL` | `http://localhost:4311` | where the UI looks for the engine |

## Checking it

```bash
npm run check             # types, contract boundary, 207 matching tests,
                          # pricing properties, live market and link validation
npm run trades:report     # what the journal says about latency and refusals
npm run trades:reconcile  # ask both venues what actually happened
npm run kalshi:close      # list or close open Kalshi positions
```

`check:markets` and `check:links` talk to the engine, so start it first.
