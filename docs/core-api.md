# Core API

`apps/core` is a small Fastify + WebSocket service. It polls public market data, runs the **simulated** agent floor, and streams what happens. This page documents what exists in the code today.

> **Status: prototype.** Core has **no authentication** and **cannot place real orders**. Agents are scripted (a momentum rule), not language models. See the [README](../README.md) for the roadmap.

Start it with `pnpm dev:core` (listens on `127.0.0.1:4000`). Configuration is by environment variable, see [`.env.example`](../.env.example):

| Variable | Default | Meaning |
|---|---|---|
| `CORE_HOST` | `127.0.0.1` | Interface to bind. Leave on loopback unless you add your own auth and TLS in front. |
| `CORE_PORT` | `4000` | Port. |
| `HERMES_MASTER_KEY` | unset | 32 random bytes (64 hex chars or base64). Enables the secret store. `pnpm --filter core keygen` makes one. |
| `HERMES_DATA_DIR` | `.hermes` | Directory for the encrypted `secrets.json` (created with 0600 permissions). |
| `CORE_ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated browser origins allowed to call core. |

## HTTP

| Method | Path | Returns |
|---|---|---|
| GET | `/` | `{ "status": "ok", "service": "hermes-core" }` |
| GET | `/feeds` | Feed status: `intervalMs`, `symbols` seen so far, `sources`, `lastUpdate` (ms epoch, 0 before the first poll) |
| GET | `/agents` | Array of agent summaries |
| GET | `/agents/:id` | One agent summary, or `404 { "error": "not found" }` |
| POST | `/agents/halt-all` | `{ "ok": true, "halted": <n> }`: stops every agent from deciding |
| POST | `/agents/resume-all` | `{ "ok": true, "resumed": <n> }` |
| GET | `/secrets` | `{ "enabled": bool, "secrets": [{ "id", "updatedAt" }] }`. Metadata only |
| PUT | `/secrets/:id` | Body `{ "value": "…" }` (1 to 4096 chars). Stores it encrypted. `503` if no master key is set |
| DELETE | `/secrets/:id` | Removes it, `404` if absent |

An agent summary has: `id, name, role, model, temperature, autonomy ("SUGGEST"|"APPROVE"|"AUTO"), state, mandate, riskLimits, tools, feeds, dailyPnL`.

Secret ids match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; the web app uses ids like `runtime.claude.key`. **There is deliberately no endpoint that returns a value.** Each value is encrypted with AES-256-GCM using a fresh IV and its id as authenticated data; core refuses to start if the master key doesn't match the existing file.

```sh
curl -s localhost:4000/agents | head -c 400
curl -s -X POST localhost:4000/agents/halt-all
```

## WebSocket

Two endpoints on the same port.

### `ws://127.0.0.1:4000/` (or `/feed`): market data

Read-only. On connect you receive the latest message per symbol, then updates every ~5 s. Messages:

```jsonc
{ "type": "price",   "symbol": "BTC-USDT", "price": 86712.1, "change24h": 1.42, "source": "binance", "ts": 1760000000000 }
{ "type": "funding", "symbol": "BTC-USDT", "rate": 0.0001, "periodHours": 8, "source": "binance", "ts": 1760000000000 }
```

`source` is `binance`, `coinbase` (fallback; USD products stand in for USDT), `frankfurter` (FX, symbols like `USD-EUR`) or `hyperliquid` (funding fallback, `periodHours: 1`). `change24h` can be `null`.

### `ws://127.0.0.1:4000/agents`: the floor

On connect you first receive one `lifecycle` message per agent. After that, every agent event:

```jsonc
{ "type": "lifecycle", "agentId": "…", "role": "…", "status": "initialized|running|paused|halted", "ts": 0 }
{ "type": "intent",    "agentId": "…", "role": "…", "symbol": "BTC-USDT", "side": "BUY|SELL|HOLD", "size": 0.02, "confidence": 0.6, "rationale": "…", "ts": 0 }
{ "type": "decision",  "agentId": "…", "role": "…", "symbol": "BTC-USDT", "action": "BUY|SELL|HOLD", "size": 0.02, "price": 86712.1, "rationale": "…", "riskChecked": true, "ts": 0 }
```

```jsonc
{ "type": "pnl", "agentId": "…", "role": "…", "pnl": -12.4, "exposure": 4800, "positions": [{ "symbol": "BTC-USDT", "qty": -0.05, "avgPx": 96000 }], "ts": 0 }
```

`pnl` is a seat's paper book marked to the latest price: realised plus unrealised since core started, in USD (average-cost accounting; negative `qty` is short). It is sent after every tick for seats that have traded, and to a new client on connect. It is also what each seat's daily loss stop reads. Halted seats keep marking.

A `decision` with `riskChecked: false` and `size: 0` is a trade the risk gate vetoed. Schemas live in [`packages/shared`](../packages/shared/src/floor.schema.ts).

The roster is `defaultAgents` in [`packages/shared`](../packages/shared/src/agentSeed.ts), the same eight seats the desk shows (a web test keeps their names, roles, models, temperature, autonomy and mandates identical). Only seats with `trades: true` (Execution Trader, Market Maker, Quant / Signals, Sentiment Desk) emit intents; the others coordinate, research or police risk. The desk matches seats by `role`.

Messages you may send (anything else is ignored; frames over 16 KiB close the connection):

```jsonc
{ "type": "subscribe", "agentId": "…", "subscribe": true }   // only receive this agent's events (subscribe:false to undo)
{ "type": "place_order", "role": "Quant / Signals", "symbol": "ETH-USDT", "side": "BUY", "size": 0.5 }   // an operator-approved order for a trading seat
{ "type": "halt_all" }
{ "type": "resume_all" }
```

Watch the stream from a terminal: `pnpm watch:core`.

## Origin policy

Core is meant to be driven by the local web app only.

- WebSocket upgrades and all non-GET HTTP requests carrying an `Origin` that is not in `CORE_ALLOWED_ORIGINS` are rejected (`403`).
- Requests with **no** `Origin` header (curl, scripts, server-to-server) are allowed. That is why the default bind is loopback: anything on your machine can talk to it.
- CORS headers are only sent for allowed origins.

If you change `CORE_HOST` to a non-loopback address, put authentication and TLS in front first.

`place_order` fills at core's last price (so you may see a different price from the one on your screen) and goes through the same checks as an agent's own decision. Unlike an agent's order it is **rejected, never clamped**, if it is over the seat's clip, if the floor is halted, if core has no price for the symbol yet, or if the seat is past its loss stop. The result comes back as an ordinary `decision` (`riskChecked: false`, `action: "HOLD"` and the reason in `rationale` when rejected). `role` matches case-insensitively and only trading seats accept orders.

## Risk gate

Every agent decision passes through `apps/core/src/risk.ts` before it is emitted as checked. `maxClip` is the largest single order in **USD notional** (sizes are in asset units, rounded down so they never exceed it), and a seat stops deciding once its daily P&L, read from its paper book, is down by `dailyLossStop` USD. Non-numeric input fails closed (no trade). Only `AUTO` seats decide on their own; `SUGGEST` and `APPROVE` seats stop at an intent that a human can turn into a `place_order`. HALT ALL overrides everything. The seeded limits are sized for a $100k paper book.

## MCP (Model Context Protocol): planned, not implemented

The goal is for external agents (Claude, OpenAI, OpenClaw, any MCP client) to plug into the desk through an MCP server exposing `get_quotes`, `get_positions`, `place_order`, `cancel_order`, `get_risk`, `read_floor` and `post_to_floor`. **None of this exists yet**, and the Setup screen in the web app marks it as a preview. Tracked on the roadmap in the README.
