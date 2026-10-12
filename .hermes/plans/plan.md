# Hermes Trading Floor Build Plan

## Current Status (as of 2026-10-02)

### Completed
- Monorepo structure with pnpm workspaces:
  - `apps/web`: Next.js 15 app with TypeScript, Tailwind, IBM Plex fonts.
  - `apps/core`: Fastify server with TypeScript setup.
  - `packages/shared`: Shared TypeScript code, Zod schemas, agent seed config.
- UI Layout (Milestone 1 – Shell + Themes) implemented:
  - Responsive layout with header, main (roster, centre window, right rail), footer.
  - Theme switching (dark, light, system, glass) persisted via localStorage.
  - Header includes brand, ticker placeholder, demo/live toggle, setup, floor open/close, halt all.
  - Footer includes theme buttons, glass opacity slider, mode display.
  - Placeholder components for Roster, CentreWindow, RightRail, Footer.
  - Header and Footer are client components using React hooks (useState).
- Shared agent seed configuration defined for eight default agents with suggested models (Claude 3 family).
- TypeScript compilation succeeds for web, core, and shared packages.

### Pending (Milestone 2+)
2. **Market Data Service (core)**
   - Implement server-side price polling from Binance public API with fallback to Coinbase.
   - WebSocket server to stream prices to connected clients.
   - Implement funding, FX, optional keyed feeds (Finnhub, Twelve Data, etc.).
   - Expose market data via WebSocket to `apps/web`.

3. **Charts**
   - Integrate TradingView Advanced Chart widget (theme-aware) with native SVG fallback.
   - Implement ticker click to change chart symbol.

4. **Onboarding (6 steps)**
   - Build full-screen overlay with step navigation.
   - Implement encrypted server-side storage of API keys (libsodium sealed box).
   - Persist onboarding completion and settings.

5. **Agent Engine**
   - Instantiate eight agent seats with models, mandates, autonomy, risk limits.
   - Implement floor bus (pub/sub) for agent communication.
   - Append-only audit log of agent messages, intents, fills.
   - Floor chat UI driven by audit log.

6. **Runtime Adapters**
   - Unified `think(ctx) → {messages[], intents[]}` interface.
   - Implement adapters: Hermes native, Anthropic Messages API, OpenAI Responses API, OpenRouter, Gemini, Ollama, DeepSeek, OpenClaw, HMAC‑signed HTTP webhook.

7. **Hermes MCP Server**
   - Expose `get_quotes, get_positions, place_order, cancel_order, get_risk, read_floor, post_to_floor` over stdio and Streamable HTTP.
   - Publish as npm package `hermes-desk-mcp`.

8. **Execution**
   - Paper venue: fill at live mid price with configurable slippage.
   - Live venue adapters: CCXT (Binance, Bybit, Coinbase Advanced), Hyperliquid SDK, Alpaca, IBKR Client Portal, EVM via viem+WalletConnect.
   - Reject keys with withdrawal permission.

9. **Risk Engine (Hard Gate)**
   - Validate intents against clip size, leverage, daily loss stop, house VaR.
   - HALT ALL kill switch.
   - Risk Officer agent can veto but cannot loosen hard limits.

10. **Approvals Queue**
    - UI for SUGGEST/APPROVE agents: pending intents with rationale, size, risk impact.
    - Approve/Edit/Reject actions.

11. **TradingView Alerts**
    - Endpoint `/hooks/tradingview` with passphrase verification → floor event.

12. **Live Mode**
    - Require ≥1 venue with valid credentials.
    - Confirmation modal before switching to live.
    - Persistent red LIVE banner when live.

### Deliverables
- Working repository with `README.md` (quick start, env vars, architecture diagram, MCP usage).
- `.env.example` covering all providers, feeds, venues.
- Seed config for eight default agents (already in `packages/shared/src/agentSeed.ts`).

### Next Immediate Steps
1. Replace placeholder UI components with real implementations:
   - Ticker with live data from market data service.
   - Roster with dynamic agent cards populated from agent engine.
   - CentreWindow tabs: Floor Chat (audit log), Blotter (fills), Console (system log).
   - RightRail: TradingView chart widget + news feed.
2. Wire up market data service (core) and connect UI via WebSocket.
3. Implement agent engine and floor bus.
4. Create Dockerfile and docker-compose.yml for full stack.
5. Write end-to-end test: onboarding → Demo mode → verify paper trade appears in chat/blotter → HALT ALL stops new trades.

### Open Questions
- Which model provider to use for each agent? (Current seed uses Claude 3 family; can be overridden via env.)
- Should we use a dedicated Redis instance for pub/sub or rely on in-memory with fallback?
- How to handle encrypted secret storage: libsodium sealed box with key derived from env/KMS?

