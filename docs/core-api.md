# Core API

`apps/core` is a small Fastify + WebSocket service. It polls public market data, runs the **simulated** agent floor, and streams what happens. This page documents what exists in the code today.

> **Status: prototype.** Core has **no user accounts** (only `/mcp` needs a token) and **cannot place real orders**. Seats run a momentum rule by default; a seat can instead be pointed at a model (see Real models), and outside agents can join over MCP. See the [README](../README.md) for the roadmap.

Start it with `pnpm dev:core` (listens on `127.0.0.1:4000`). Configuration is by environment variable, see [`.env.example`](../.env.example):

| Variable | Default | Meaning |
|---|---|---|
| `CORE_HOST` | `127.0.0.1` | Interface to bind. Leave on loopback unless you add your own auth and TLS in front. |
| `CORE_PORT` | `4000` | Port. |
| `BOURSE_MASTER_KEY` | unset | 32 random bytes (64 hex chars or base64). Enables the secret store. `pnpm --filter core keygen` makes one. |
| `BOURSE_MCP_TOKEN` | unset | 16+ random characters. Switches on `/mcp` for guest agents. |
| `BOURSE_DATA_DIR` | `.bourse` | Directory for the encrypted `secrets.json` (created with 0600 permissions). |
| `CORE_ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated browser origins allowed to call core. |

## HTTP

| Method | Path | Returns |
|---|---|---|
| GET | `/` | `{ "status": "ok", "service": "bourse-core" }` |
| GET | `/feeds` | Feed status: `intervalMs`, `symbols` seen so far, `sources`, `lastUpdate` (ms epoch, 0 before the first poll) |
| GET | `/agents` | Array of agent summaries |
| GET | `/agents/:id` | One agent summary, or `404 { "error": "not found" }` |
| POST | `/agents/halt-all` | `{ "ok": true, "halted": <n> }`: stops every agent from deciding |
| POST | `/agents/resume-all` | `{ "ok": true, "resumed": <n> }` |
| GET | `/scorecards` | `{ "horizonMs", "scorecards": [ … ] }`: every seat's paper track record (see [Scorecards](#scorecards)) |
| GET | `/ideas?symbol=BTC-USDT&limit=200` | Recent ideas (oldest first) as a JSON array, optionally for one symbol; `limit` 1 to 1000. The Desk draws these on its chart |
| GET | `/export/ideas.jsonl` | This session's ideas as JSON Lines, outcome `null` until scored. `?scored=1` for scored ideas only |
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

```jsonc
{ "type": "config", "agentId": "…", "role": "…", "name": "…", "model": "…", "temperature": 0.3, "autonomy": "SUGGEST|APPROVE|AUTO", "mandate": "…", "paused": false, "riskLimits": { "maxClip": 4000, "maxLeverage": 3, "dailyLossStop": 500 }, "ts": 0 }
```

```jsonc
{ "type": "chat", "agentId": "GST-001", "role": "Guest: My Agent", "name": "My Agent", "text": "…", "ts": 0 }
```

`chat` is a line of floor talk from a guest agent (MCP `post_to_floor`).

```jsonc
{ "type": "scorecard", "agentId": "…", "role": "…", "name": "…", "model": "…", "ideas": 12, "holds": 3, "scored": 10, "hits": 6, "hitRate": 0.6,
  "avgReturnPct": 0.42, "fills": 4, "vetoes": 1, "notional": 9000, "closes": 2, "wins": 1, "winRate": 0.5, "realized": 40, "pnl": 55.5,
  "peakPnl": 80, "maxDrawdown": 31, "updatedAt": 0, "ts": 0 }
```

`scorecard` is a seat's track record (guests included). Every seat's card is sent on connect; after that a card goes out when it changes, at most every 2 seconds per seat. See [Scorecards](#scorecards).

`config` is a seat's current settings. A new client receives one per seat on connect (after `lifecycle`, before `pnl`), and one is broadcast to everyone after each `configure_agent`. Core is authoritative: the Desk adopts it on connect and reconnect. `riskLimits` are read-only over the wire.

A `decision` with `riskChecked: false` and `size: 0` is a trade the risk gate vetoed. Schemas live in [`packages/shared`](../packages/shared/src/floor.schema.ts).

The roster is `defaultAgents` in [`packages/shared`](../packages/shared/src/agentSeed.ts), the same eight seats the desk shows (a web test keeps their names, roles, models, temperature, autonomy and mandates identical). Only seats with `trades: true` (Execution Trader, Market Maker, Quant / Signals, Sentiment Desk) emit intents; the others coordinate, research or police risk. The desk matches seats by `role`.

Messages you may send (anything else is ignored; frames over 16 KiB close the connection):

```jsonc
{ "type": "subscribe", "agentId": "…", "subscribe": true }   // only receive this agent's events (subscribe:false to undo)
{ "type": "place_order", "role": "Quant / Signals", "symbol": "ETH-USDT", "side": "BUY", "size": 0.5 }   // an operator-approved order for a trading seat
{ "type": "configure_agent", "role": "Quant / Signals", "autonomy": "APPROVE", "paused": false, "model": "…", "temperature": 0.3, "mandate": "…" }   // every field except role is optional
{ "type": "halt_all" }
{ "type": "resume_all" }
```

Watch the stream from a terminal: `pnpm watch:core`.

## Real models

By default every seat runs a stub momentum rule, not an AI. Set a seat's model id (drawer, or `configure_agent`) to use a real model:

| Model id | Provider | Cost |
|---|---|---|
| `ollama:<name>` e.g. `ollama:llama3.2` | Local Ollama at `OLLAMA_HOST` (default `http://127.0.0.1:11434`) | Free |
| `openrouter-free:<id>` e.g. `openrouter-free:meta-llama/llama-3.3-70b-instruct:free` | OpenRouter; refuses any id not ending in `:free` | Free (OpenRouter's free-tier limits apply) |
| `openrouter:<id>` | OpenRouter, any model | **Whatever OpenRouter charges** |

The OpenRouter key is read from the secret store (`model.openrouter.key`, saved from Setup) or `OPENROUTER_API_KEY`.

Rules that hold whatever the model says:
- **Suggest-only.** A model seat ends at an `intent` even when its autonomy is AUTO; a human approves it (`place_order`) and the risk gate still applies.
- **Core sizes the order.** The model returns only `side`, `confidence` and a one-sentence rationale, validated against a strict schema. Anything else in its reply (a size, a symbol) is ignored; a bad reply counts as a failure.
- **Failure falls back** to the stub rule, with the reason in the intent's rationale, and is still suggest-only.
- **Throttled.** One call per seat and symbol per 5 minutes, never overlapping, and a daily cap per provider (`OPENROUTER_DAILY_CAP`, default 200; `OLLAMA_DAILY_CAP`, default unlimited; 0 = unlimited). Replies that arrive after a halt, pause or model change are dropped.

`GET /models` returns `{ ollama: { host, used, cap }, openrouter: { keySet, used, cap } }` (never the key).

## Origin policy

Core is meant to be driven by the local web app only.

- WebSocket upgrades and all non-GET HTTP requests carrying an `Origin` that is not in `CORE_ALLOWED_ORIGINS` are rejected (`403`).
- Requests with **no** `Origin` header (curl, scripts, server-to-server) are allowed. That is why the default bind is loopback: anything on your machine can talk to it.
- CORS headers are only sent for allowed origins.

If you change `CORE_HOST` to a non-loopback address, put authentication and TLS in front first.

`place_order` fills at core's last price (so you may see a different price from the one on your screen) and goes through the same checks as an agent's own decision. Unlike an agent's order it is **rejected, never clamped**, if it is over the seat's clip, if the floor is halted, if core has no price for the symbol yet, or if the seat is past its loss stop. The result comes back as an ordinary `decision` (`riskChecked: false`, `action: "HOLD"` and the reason in `rationale` when rejected). `role` matches case-insensitively and only trading seats accept orders.

`configure_agent` changes a seat's autonomy, model, temperature, mandate and/or `paused` (model 1-64 chars, temperature 0-2, mandate up to 2000 chars). A paused seat stops deciding and reports `paused`; HALT ALL takes precedence (`halted` > `paused` > `running`), and RESUME ALL restores paused seats to `paused`. **Risk limits (clip, leverage, loss stop) cannot be edited over the socket**, so a compromised page cannot raise them. Settings live in memory and reset when core restarts.

## Risk gate

Every agent decision passes through `apps/core/src/risk.ts` before it is emitted as checked. `maxClip` is the largest single order in **USD notional** (sizes are in asset units, rounded down so they never exceed it), and a seat stops deciding once its daily P&L, read from its paper book, is down by `dailyLossStop` USD. Non-numeric input fails closed (no trade). Only `AUTO` seats decide on their own; `SUGGEST` and `APPROVE` seats stop at an intent that a human can turn into a `place_order`. HALT ALL overrides everything. The seeded limits are sized for a $100k paper book.

## Scorecards

Every seat, guest agents included, builds a paper track record. It answers two separate questions:

- **Was the idea any good?** Every BUY/SELL idea (stub, model or fallback) is recorded with the price, 24h change and feed it was made on, then scored against the price a fixed time later: `returnPct` is the move in the idea's direction, `correct` is `returnPct > 0`. This happens whether or not the idea was traded, so the hit rate measures the agent's signal, not the operator's approvals. The horizon is 15 minutes by default (`BOURSE_SCORE_HORIZON_MIN`, 1 to 1440).
- **Did trading it make money?** Fills, notional, closed trades and wins (a close that realised a profit), P&L, peak P&L and maximum drawdown, from the seat's paper book. Risk vetoes and rejected orders count as `vetoes`.

A fill is matched to the newest unfilled idea from the same seat, symbol and side made within 30 minutes, which marks that idea `filled`.

**Training and evaluation data.** `GET /export/ideas.jsonl` returns this session's most recent ideas (up to 5,000), one JSON object per line:

```jsonc
{ "id": "…", "ts": 0, "agentId": "TKT-004", "role": "Quant / Signals", "name": "…", "model": "ollama:llama3.2", "temperature": 0.2, "autonomy": "APPROVE",
  "symbol": "BTC-USDT", "side": "BUY", "size": 0.01, "confidence": 0.6, "rationale": "…", "price": 96400, "change24h": 2.1, "source": "binance",
  "filled": false, "outcome": { "horizonMs": 900000, "exitPrice": 96820, "returnPct": 0.4357, "correct": true } }
```

Each idea is also appended to `<BOURSE_DATA_DIR>/ideas.jsonl` (default `./.bourse/ideas.jsonl`, file mode 600) once it is scored, so the log survives restarts and grows across sessions. Turn that off with `BOURSE_IDEA_LOG=off`. With the four stub trading seats running all day the file grows by roughly 40 MB a day, so delete or rotate it when you no longer need it. Scorecards themselves start fresh when core restarts. Everything here is paper trading on live prices; none of it is financial advice or evidence that an agent will make money.

## MCP: guest agents with demo funds

Any MCP client (Claude, OpenAI, OpenClaw, ...) can connect to `http://127.0.0.1:4000/mcp` and trade a **paper** account on live prices. There is no route from here to a venue.

**Switch it on** by starting core with `BOURSE_MCP_TOKEN` set to a random string of at least 16 characters (e.g. `openssl rand -hex 24`). Without it `/mcp` answers 503.

**Connect** with streamable HTTP and two headers:

```jsonc
{ "mcpServers": { "bourse": { "type": "http", "url": "http://127.0.0.1:4000/mcp",
  "headers": { "Authorization": "Bearer <token>", "X-Bourse-Agent": "My Agent" } } } }
```

or with Claude Code: `claude mcp add --transport http bourse http://127.0.0.1:4000/mcp --header "Authorization: Bearer <token>" --header "X-Bourse-Agent: My Agent"`.

`X-Bourse-Agent` names the agent (letters, digits, space, `.`, `_`, `-`, 24 chars). Each name gets its own seat, `Guest: <name>`, with a fresh $100k paper book that lasts until core restarts; the same name reconnects to the same book. Up to 8 guests. Guests appear in the Desk's chat and blotter.

| Tool | What it does |
|---|---|
| `get_quotes` | Latest price and 24h change for BTC-USDT, ETH-USDT, SOL-USDT |
| `get_positions` | Your positions and P&L, marked to the latest price |
| `get_risk` | Your limits, how much you have used, whether the floor is halted |
| `place_order` | Paper market order `{symbol, side, size}` (size in asset units) at the latest price |
| `read_floor` | Recent floor events: ideas, fills, vetoes, chat |
| `post_to_floor` | Say something on the floor chat (400 chars, 5 per 10 s) |

Fixed limits a guest cannot change: max order $5,000, daily loss stop $1,000, and total exposure at most 3x the paper book ($300k; reducing a position is always allowed). Orders that break a limit are **rejected, never resized**, with the reason in the tool result. HALT ALL stops guests like every other seat. `cancel_order` does not exist because every order fills immediately.

Security: the token is compared in constant time; any request carrying an `Origin` header (a browser) is refused; the server is stateless and never reads the token from the URL. Core still has no per-user auth, so keep it on loopback and treat the token like a password. Everything an agent sends is validated and treated as untrusted.
