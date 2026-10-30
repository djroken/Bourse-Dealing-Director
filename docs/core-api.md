# Core API

`apps/core` is a small Fastify + WebSocket service. It polls public market data, runs the **simulated** agent floor, and streams what happens. This page documents what exists in the code today.

> **Status: prototype.** Core has **no user accounts** (only `/mcp` needs a token) and **cannot place real-money orders**: approved orders can go to a broker's paper account (play money), never a live one. Seats run a momentum rule by default; a seat can instead be pointed at a model (see Real models), and outside agents can join over MCP. See the [README](../README.md) for the roadmap.

Start it with `pnpm dev:core` (listens on `127.0.0.1:4000`). Configuration is by environment variable, see [`.env.example`](../.env.example). A `.env` file in the repo root (or `apps/core`) is read at start-up; variables already set in the environment win:

| Variable | Default | Meaning |
|---|---|---|
| `CORE_HOST` | `127.0.0.1` | Interface to bind. Leave on loopback unless you add your own auth and TLS in front. |
| `CORE_PORT` | `4000` | Port. |
| `BOURSE_MASTER_KEY` | unset | 32 random bytes (64 hex chars or base64) for the secret store. `pnpm --filter core keygen` makes one. Unset, core uses `<BOURSE_DATA_DIR>/master.key`, creating it (0600) on a fresh install, so Setup can save keys straight away. That stops casual copying of `secrets.json` but not someone who can read the folder: set the variable yourself to keep the key off disk. |
| `BOURSE_AUTO_MASTER_KEY` | on | `off` stops core from creating or using `master.key`: the key store then needs `BOURSE_MASTER_KEY`. |
| `BOURSE_MCP_TOKEN` | unset | 16+ random characters. Switches on `/mcp` for guest agents. |
| `BOURSE_DATA_DIR` | `.bourse` | Directory for the encrypted `secrets.json` (created with 0600 permissions). |
| `BOURSE_CRYPTO` | unset | Extra coins with a Binance USDT market, comma-separated (e.g. `DOGE,ADA`), on top of BTC, ETH, SOL, BNB, XRP. Up to 12. |
| `BOURSE_STOCKS` | `SPY,AAPL,NVDA,TSLA` | US tickers to trade, when an Alpaca key is set. Up to 12. |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | unset | Alpaca paper-account key: market data, and Alpaca paper trading if you switch it on. Or save them in Setup as `data.alpaca.key` / `data.alpaca.secret`. |
| `BOURSE_VENUE_STOCKS` | `sim` | `alpaca-paper` sends US stock orders you approve to your Alpaca paper account. See [Broker paper accounts](#broker-paper-accounts). |
| `BOURSE_VENUE_CRYPTO` | `sim` | `binance-testnet` sends crypto orders you approve to the Binance spot testnet. |
| `BINANCE_TESTNET_API_KEY`, `BINANCE_TESTNET_API_SECRET` | unset | Binance spot testnet key (testnet.binance.vision). Or save them in Setup as `venue.binance-testnet.key` / `.secret`. |
| `BOURSE_NEWS_FEEDS` | CoinDesk, Cointelegraph, Decrypt, Federal Reserve | Public RSS/Atom feeds for headlines: comma-separated https URLs, optionally `Name=https://…`, at most 8. `off` turns news off. See [News](#news). |
| `BOURSE_TALK_LOG` | on | Write every floor-conversation model call to `<BOURSE_DATA_DIR>/talk.jsonl`. `off` to stop. |
| `BOURSE_TALK_MIN` | `15` | Minutes between [floor conversation](#floor-conversation) rounds. `0` = only when you instruct the floor. |
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
| GET | `/export/talk.jsonl` | This session's floor-conversation model calls as JSON Lines (see [Floor conversation](#floor-conversation)), each joined with its idea's outcome. `?scored=1` for calls whose idea has been scored |
| GET | `/export/ideas.jsonl` | This session's ideas as JSON Lines, outcome `null` until scored. `?scored=1` for scored ideas only |
| POST | `/paper/reset` | `{ "ok": true }`: every paper book and scorecard back to zero; seat settings are kept. Not undoable |
| POST | `/replay` | Start a replay (see [Replay](#replay)). `202` with the job, `409` if one is already running, `400` on a bad body |
| GET | `/replay` | `{ "job": … }`: the current or last replay, or `null` |
| GET | `/replay/:id` | That job: `status` (`fetching`, `running`, `done`, `failed`, `cancelled`), `progress` 0..1, `params`, `result` |
| DELETE | `/replay/:id` | Cancel a running replay |
| GET | `/replay/:id/ideas.jsonl` | Every idea of a finished replay with its outcome and P&L, as JSON Lines |
| GET | `/instruments` | `{ instruments: [{ symbol, kind, label, dp, tv, … }], stocks: { enabled, keySet, needsRestart, market } }`. See [Markets](#markets) |
| GET | `/candles?symbol=AAPL&tf=5m` | Up to 120 candles for a **stock** (`tf` 1m, 5m, 15m, 1h, 4h, 1d), for the Desk's chart. Crypto candles come from the exchanges directly |
| GET | `/floor/talk` | `{ enabled, intervalMs, running, lastRoundAt, rounds }`: the floor conversation (see [Floor conversation](#floor-conversation)) |
| POST | `/floor/round` | Start a round now. `202 { "ok": true }`, or `409` if one is already running |
| GET | `/news` | `{ feeds: [{ name, url, ok, at, items, error? }], headlines, latest: [ … ] }`: feed status and the latest headlines |
| GET | `/venues` | `{ venues: [{ id, label, markets, enabled, keySet, routing, sandbox }], live: false }`: the broker paper accounts (see [Broker paper accounts](#broker-paper-accounts)) |
| PUT | `/venues/:id` | Body `{ "enabled": true\|false }`: route approved orders to that sandbox, or back to core's paper venue. Until restart |
| POST | `/venues/:id/check` | One authenticated read of the sandbox account: `{ ok: true, detail }` or `{ ok: false, reason }` |
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
{ "type": "chat", "agentId": "TKT-004", "role": "Quant / Signals", "name": "Pico Nandra", "text": "…", "round": "R…", "model": "ollama:llama3.2", "ts": 0 }
{ "type": "chat", "agentId": "TKT-007", "role": "Risk Officer", "name": "Bastion Cole", "text": "…", "round": "R…", "stub": true, "ts": 0 }
{ "type": "chat", "agentId": "OWNER", "role": "Owner", "name": "YOU", "text": "…", "round": "R…", "ts": 0 }
```

`chat` is a line of floor talk: a seat speaking in a [floor conversation](#floor-conversation) (`model` says which model wrote it, `stub: true` that the stub rule did), the owner's instruction echoed back (`agentId: "OWNER"`), or a guest agent (MCP `post_to_floor`, no `round`). Text is capped at 480 characters.

```jsonc
{ "type": "usage", "agentId": "…", "role": "…", "callsToday": 12, "tokensToday": 18460, "spendToday": 0.0042, "latencyMs": 1830, "lastError": null, "ts": 0 }
```

```jsonc
{ "type": "thinking", "agentId": "TKT-004", "role": "Quant / Signals", "round": "T…", "on": true, "ts": 0 }
```

`thinking` says a model seat is working on its line in a round (`on: true`) and when it's done or gave up (`on: false`), so the Desk can show "Pico is thinking" instead of silence while a slow model answers. Stub seats never send it.

```jsonc
{ "type": "news", "id": "afa7bd3dae4828b4", "source": "CoinDesk", "title": "…", "url": "https://…" , "publishedAt": 0, "tag": "MACRO|FLOW|VENUE|ON-CHAIN|MARKET", "symbols": ["SOL-USDT"], "ts": 0 }
```

`news` is a headline from the [news feeds](#news), sent once when core first sees it. A new client receives the latest 20 on connect. `url` is `null` unless it is an http(s) link.

`usage` is a model seat's metering for the UTC day: calls, prompt plus completion tokens, spend in USD (`0` on Ollama and free OpenRouter models, `null` if the provider didn't report a cost) and the latency of the last call. Sent on connect and at most once a second per seat. `lastError` is why the seat's last model call failed (no key, unknown model, rate limit, daily cap), or `null`; it is sent as soon as it changes. The Desk's drawer shows it as TOKENS TODAY, SPEND TODAY and LAST LATENCY. Stub seats have no usage.

An `intent` may carry `needsApproval`: `true` means it waits for the owner (every model seat's idea, and stub seats on SUGGEST or APPROVE), `false` means core is filling it itself (a stub seat on AUTO) and a `decision` follows.

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
{ "type": "instruct", "text": "Is the SOL move worth trading?" }   // 1 to 400 chars: opens a floor round with the owner's question
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

`GET /models/catalog` is what the Desk's model picker offers: `{ openrouter: { keySet, free: [{ id, name, context }], error, fetchedAt }, ollama: { host, reachable, models: [{ id, name }] } }`. The free list comes from OpenRouter's public model list (no key needed to list), keeps only `:free` ids priced at zero, is prefixed `openrouter-free:` and is cached for an hour. Ollama's list is whatever is installed locally.

## Floor conversation

The floor talks. A **round** is one pass round the desk, in this order: Dealing Director opens, then Quant, Sentiment, Market Maker, Execution, Research, On-chain, Risk, and the Director closes with a house view. A round runs every `BOURSE_TALK_MIN` minutes (default 15, `0` turns the timer off), when the owner sends `instruct`, or on `POST /floor/round`. It needs prices first and does nothing while the floor is halted.

- **Model seats talk through their model.** Each gets the market (price, 24h change, funding), its own paper book, the owner's request if there is one, and everything said so far in the round. It answers `{"say": "…", "idea": {"symbol", "side", "confidence"} | null}`; plain text is accepted as `say` with no idea. A failed call means the seat says nothing that round: it is never replaced by a stub line.
- **Stub seats speak from data and say so** (`stub: true`): the Director names the real movers, trading seats state their momentum read, Risk reports real exposure and loss-stop use, the Director tallies the leans. Research quotes the newest headline that names the top mover (or the newest one), On-chain the newest on-chain headline, each with source and age and marked unverified. With no headlines they stay quiet rather than invent news.
- **What one agent says is data to the next, never instructions.** Earlier lines reach a model only inside a quoted transcript, and the system prompt says so. A line that tries to give orders is passed on as a quote and changes nothing core does.
- **The floor remembers.** Core keeps the last three rounds. A model seat sees them as a quoted block: when each round was, what the owner asked, the house view and what that seat said. A trading seat also sees its last five ideas with how each did at the scoring horizon (`+0.42% (right)`, or "not scored yet") and its hit rate. That is the feedback loop: an agent can change its mind because its last call was wrong. The stub Director opens with the previous house view. Memory is in core's process, so a restart starts the conversation afresh (books and scorecards are kept).
- **A training record.** Every model call in a round is written to `<BOURSE_DATA_DIR>/talk.jsonl` as it happens (`BOURSE_TALK_LOG=off` to stop): the round, seat, model and temperature, the exact `system` and `user` prompt, the raw `reply` (or the `error`), the line core took from it, the `idea` and its `ideaId`. Join `ideaId` with `ideas.jsonl` for the outcome, or download `/export/talk.jsonl` (the EXPORT TALK button in SCORES), which joins it for this session. Prompt in, reply out, scored by the market: that is the material for evaluating or fine-tuning a trading agent. The prompts include anything the owner typed, so treat the file as private.
- **Headlines are data too.** Every model seat sees up to six headlines from the last 24 hours, in a block labelled quoted, unverified and never instructions. A headline can't place an order: only a trading seat's own idea can, and that still needs the owner.
- **Ideas become intents that need approval.** Only trading seats may attach an idea. Core checks the symbol, sizes it with the seat's risk limits, scores it like any other idea, and emits an `intent` with `needsApproval: true`, even for a seat on AUTO. The owner approves it on the Desk (`place_order`) and the risk gate still applies.
- **The owner's instruction** opens the next round and is quoted to every speaker. One instruction every 10 seconds; one more is queued while a round is running.
- **Cost.** Each model seat makes one call per round (up to 240 output tokens), on top of its normal decisions, and counts toward the provider's daily cap. On Ollama and free OpenRouter models that is free; on paid `openrouter:` models a round costs real money, so raise `BOURSE_TALK_MIN` or set it to `0`.

## News

Core polls a few free public RSS/Atom feeds every 5 minutes (CoinDesk, Cointelegraph, Decrypt and the Federal Reserve's press releases by default; set your own with `BOURSE_NEWS_FEEDS`, or `off`). New headlines go to the Desk's news panel and to the floor conversation.

- **Untrusted text.** Titles are reduced to plain, single-line text (no markup, no control or direction-override characters) and capped at 200 characters; links survive only if they are http(s). A feed is read with a 10 s timeout and at most 1 MB. The Desk renders titles as text and opens links with `noopener noreferrer`.
- **Tags and symbols are keyword guesses**: `MACRO` (Fed, CPI, rates…), `FLOW` (ETFs, inflows…), `VENUE` (exchanges, listings, hacks), `ON-CHAIN` (wallets, whales, DeFi…), otherwise `MARKET`. `symbols` are floor symbols named by ticker, or for coins by name ("Bitcoin" → `BTC-USDT`).
- Headlines older than 48 hours are ignored, and a date in the future is replaced by the time core first saw it. One failing feed doesn't stop the others; `GET /news` shows each feed's last result.

## Broker paper accounts

By default an order you approve fills on core's paper venue at core's last price. Switch on a broker's paper account and it goes to the broker instead, so your agents' trades meet a real order-handling system (lot sizes, minimums, balances, rejections) with play money:

| id | Markets | Account | Keys |
|---|---|---|---|
| `binance-testnet` | Crypto (USDT pairs) | [Binance spot testnet](https://testnet.binance.vision), free, log in with GitHub | `venue.binance-testnet.key` / `.secret`, or `BINANCE_TESTNET_API_KEY` / `_SECRET` |
| `alpaca-paper` | US stocks | Your Alpaca paper account, free | The Alpaca key used for market data |

Switch one on in Setup (step 04, ROUTE APPROVED ORDERS HERE), with `PUT /venues/:id`, or at start-up with `BOURSE_VENUE_CRYPTO=binance-testnet` / `BOURSE_VENUE_STOCKS=alpaca-paper`. CHECK KEY makes one read-only call to the account.

- **Sandboxes only.** The broker URLs (`testnet.binance.vision`, `paper-api.alpaca.markets`) are constants in [`venues.ts`](../apps/core/src/venues.ts), not settings, and a test fails if any other host appears there. Nothing here can reach a live account. `live` is always `false`.
- **Same gate first.** The order passes every check of a paper order (halt, clip, loss stop, market hours) before it is sent. A refused order never reaches the broker.
- **Core books the broker's fill**: its quantity and average price, rounded to the venue's lot size (always down). The `decision` carries `venue` and `venueOrderId`. A refusal comes back as a `decision` with `riskChecked: false` and the broker's reason, and books nothing. A fill for more than was asked, or with no price, is not booked. If the fill is 1% or more from core's price the rationale says so.
- **What goes there.** Only orders you approve. AUTO stub seats and MCP guests keep filling on core's paper venue, so a busy floor can't flood a testnet account.
- **Known gaps.** Binance's testnet is spot only: a sell needs testnet coins, so shorts are refused. Testnet prices can drift from the real market. An Alpaca order that hasn't filled in 10 seconds is cancelled and only what filled is booked. Core's paper book and the broker account are separate ledgers and can drift; the broker's own page is the truth for the broker side.

## Origin policy

Core is meant to be driven by the local web app only.

- WebSocket upgrades and all non-GET HTTP requests carrying an `Origin` that is not in `CORE_ALLOWED_ORIGINS` are rejected (`403`).
- Requests with **no** `Origin` header (curl, scripts, server-to-server) are allowed. That is why the default bind is loopback: anything on your machine can talk to it.
- CORS headers are only sent for allowed origins.

If you change `CORE_HOST` to a non-loopback address, put authentication and TLS in front first.

`place_order` fills at core's last price (so you may see a different price from the one on your screen) and goes through the same checks as an agent's own decision. Unlike an agent's order it is **rejected, never clamped**, if it is over the seat's clip, if the floor is halted, if core has no price for the symbol yet, or if the seat is past its loss stop. The result comes back as an ordinary `decision` (`riskChecked: false`, `action: "HOLD"` and the reason in `rationale` when rejected). `role` matches case-insensitively and only trading seats accept orders.

`configure_agent` changes a seat's autonomy, model, temperature, mandate and/or `paused` (model 1-96 chars, temperature 0-2, mandate up to 2000 chars). A paused seat stops deciding and reports `paused`; HALT ALL takes precedence (`halted` > `paused` > `running`), and RESUME ALL restores paused seats to `paused`. **Risk limits (clip, leverage, loss stop) cannot be edited over the socket**, so a compromised page cannot raise them. Settings live in memory and reset when core restarts.

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

## Markets

The floor trades whatever `GET /instruments` lists. Everything (feed, agents, approvals, MCP, replay, the Desk's tape) uses that one list.

- **Crypto**, always on, no key: BTC, ETH, SOL, BNB and XRP against USDT, plus any coins in `BOURSE_CRYPTO`. Quotes from Binance, with Coinbase as a fallback (BNB has no Coinbase market, so no fallback). Funding from Binance futures or Hyperliquid.
- **US stocks**, when an Alpaca market-data key is configured (a free Alpaca paper account gives you one). Default list `SPY, AAPL, NVDA, TSLA`, or set `BOURSE_STOCKS`. Quotes come from Alpaca's free IEX feed every poll; a stock's "24h change" is the change from the previous session's close, the way stock moves are quoted. Sizes are in shares (fractional is fine on paper).
  - Agents only decide on a stock while the US market is in its regular session (Alpaca's clock, which knows holidays; regular hours Monday to Friday 09:30–16:00 New York if the clock can't be reached). Orders for a stock are refused while the market is closed. Books keep marking either way.
  - Core decides the list at start: if you save an Alpaca key in Setup while core is running, restart core to add the stocks (`/instruments` reports `needsRestart`).
  - Core only reads market data from Alpaca. There is no order route to Alpaca or anywhere else.
- **FX is not tradeable yet.** The free no-key source (the ECB, via Frankfurter) publishes one rate a day, which is fine as a reference and useless for trading; those rates still appear on the feed as `USD-EUR`, `USD-GBP`, `USD-JPY`.

## Replay

Replay runs the trading seats over past candles so you can judge an agent (or a change to its model or mandate) in minutes instead of waiting days for live ideas to be scored.

```jsonc
// POST /replay
{ "symbol": "BTC-USDT",      // any instrument on the floor (GET /instruments), stocks included
  "timeframe": "5m",         // 1m, 5m, 15m or 1h
  "days": 7,                 // 1 to 30
  "horizon": 3,              // candles between an idea and its outcome (1 to 96), default 3
  "feeBps": 5,               // fee per side in basis points (0 to 100), default 5
  "maxModelCalls": 60,       // per model seat (1 to 500), default 60
  "roles": ["Quant / Signals"] }  // optional: default every trading seat
```

How it works, and the rules it keeps:

- Core fetches the candles itself (crypto: Binance, then Coinbase; stocks: Alpaca bars) plus history before the window (24 hours for crypto, 4 days for stocks to cover weekends), so the first candle already has a 24h change. "24h ago" is by the clock, so it works across overnight and weekend gaps. At most 50,000 candles.
- **No look-ahead.** At candle *i* a seat sees the close of *i* and the 24h change computed from candles up to *i*, nothing else. The close `horizon` candles later is read only after the decision.
- Each seat uses its **current** model, temperature, mandate and clip, so you can edit a seat in the drawer and replay it straight away. Seats whose model isn't an `ollama:`/`openrouter:` id run the stub rule and are labelled `stub rule (… not connected)`.
- Every BUY/SELL idea is a fixed-horizon paper trade: in at the close it was made on, out `horizon` candles later, sized as live intents are sized, minus `feeBps` on both sides. No slippage, no compounding, no overlap limits. `hitRate` counts ideas that moved the right way; `winRate` counts trades that made money after fees; `maxDrawdown` is on the equity curve with each trade booked when it closes.
- Model seats are sampled evenly across the window to stay within `maxModelCalls`. Model calls count towards the same daily caps as live calls (`OLLAMA_DAILY_CAP`, `OPENROUTER_DAILY_CAP`); paid OpenRouter models cost money. A failed model call is counted in `failed` and is **never** replaced by the stub rule, so a model's numbers are only ever its own.
- One replay at a time. The last one is kept until core restarts.

Replay results are a test on history, not a forecast and not financial advice.

## Paper state across restarts

Core saves the floor to `<BOURSE_DATA_DIR>/state.json` (default `./.bourse/state.json`, mode 600) every 30 seconds and when it stops, and loads it on start:

- every paper book, guest agents' included (guests come back under the same name);
- each seat's model, temperature, autonomy, mandate and paused state (risk limits always come from the code);
- the scorecards and the ideas behind them.

Seats are matched by role. A file that doesn't validate is moved aside to `state.json.bad-<time>` and core starts a fresh floor rather than half-loading it. `BOURSE_PERSIST=off` turns all of this off.

An idea whose horizon passed while core was stopped (or while the feed was down for more than 5 minutes past the horizon) is marked `expired` and never scored, so a restart can't score it on an unrelated later price.

The **daily loss stop counts each UTC day on its own**: at the first mark after midnight UTC a seat's loss-stop P&L starts again from zero, while its total P&L and scorecard carry on. `get_risk` (MCP) reports both `pnl` (total) and `todayPnl`.

`POST /paper/reset` (the Desk's **RESET PAPER**, which asks for a second click) zeroes every book and scorecard and clears the idea list. The `ideas.jsonl` log on disk is left alone.

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
| `get_quotes` | Latest price and change for every instrument on the floor; stocks carry `marketOpen` |
| `get_positions` | Your positions and P&L, marked to the latest price |
| `get_risk` | Your limits, how much you have used, whether the floor is halted |
| `place_order` | Paper market order `{symbol, side, size}` (size in asset units) at the latest price |
| `read_floor` | Recent floor events: ideas, fills, vetoes, chat |
| `post_to_floor` | Say something on the floor chat (400 chars, 5 per 10 s) |

Fixed limits a guest cannot change: max order $5,000, daily loss stop $1,000, and total exposure at most 3x the paper book ($300k; reducing a position is always allowed). Orders that break a limit are **rejected, never resized**, with the reason in the tool result. HALT ALL stops guests like every other seat. `cancel_order` does not exist because every order fills immediately.

Security: the token is compared in constant time; any request carrying an `Origin` header (a browser) is refused; the server is stateless and never reads the token from the URL. Core still has no per-user auth, so keep it on loopback and treat the token like a password. Everything an agent sends is validated and treated as untrusted.
