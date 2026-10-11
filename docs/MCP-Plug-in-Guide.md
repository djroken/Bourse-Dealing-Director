# MCP Plug-in Guide — Hermes Trading Floor

**Purpose:** Connect external LLM agents (Claude, OpenClaw, custom models) to the Hermes Trading Floor via the MCP (Multi-Client Protocol) bridge. External agents can subscribe to the `/agents` WS feed, receive lifecycle/intent/decision messages, and submit new intents through a constrained JSON-RPC-over-WS interface.

---

## Architecture Overview

```
External Agent (Claude/OpenClaw)
         │
         ▼
   MCP Bridge (local process or hosted service)
         │
         ▼
   Hermes Core (:4000)
         │           │
         ▼           ▼
  /agents WS  ←→  Market data WS (/feeds)
         │           │
         ▼           ▼
   Agent Engine  Price/funding ticks
```

---

## WS Endpoint

`ws://localhost:4000/agents`

**Sub-protocol:** JSON-lines (one valid JSON object per WS frame)

**Message types (inbound to core):**

| Type | Fields | Description |
|---|---|---|
| `lifecycle` | `agentId`, `role`, `status` | Request status change (e.g. `paused`, `halted`) |
| `intent` | `agentId`, `role`, `symbol`, `side`, `size`, `confidence`, `rationale` | Submit a new intent (SUGGEST autonomy only) |
| `decision` | `agentId`, `role`, `symbol`, `action`, `size`, `price`, `rationale`, `riskChecked` | Submit a decision (AUTO autonomy only) |
| `subscribe` | `agentId`, `subscribe` | Subscribe/unsubscribe to a specific agent's broadcast |

**Message types (from core → external agent, broadcast on same WS):**

| Type | Fields | Description |
|---|---|---|
| `lifecycle` | `agentId`, `role`, `status` | Agent status change (initialized → running → halted) |
| `intent` | `agentId`, `role`, `symbol`, `side`, `size`, `confidence`, `rationale` | Agent evaluated intent (AUTO: also includes decision) |
| `decision` | `agentId`, `role`, `symbol`, `action`, `size`, `price`, `rationale`, `riskChecked` | Agent decision (AUTO agents only) |

---

## Connecting

```javascript
const ws = new WebSocket('ws://localhost:4000/agents');
ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', agentId: 'TKT-001' }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  // msg.type === 'lifecycle' | 'intent' | 'decision'
  renderToUI(msg);
};
```

---

## Submitting Intents (SUGGEST autonomy only)

External agents **cannot** submit `decision` messages directly — the core enforces that only AUTO agents (Dealing Director, Execution Trader, Market Maker, Quant/Signals) emit decisions. SUGGEST agents (Research/News, On-chain Analyst, Risk Officer, Sentiment) must emit `intent` only; the core's risk engine validates against daily loss stops and max clip/leverage limits before any decision is broadcast.

```javascript
ws.send(JSON.stringify({
  type: 'intent',
  agentId: 'TKT-005',        // Research/News
  role: 'Research/News',
  symbol: 'BTC-USDT',
  side: 'BUY',
  size: 2,
  confidence: 0.85,
  rationale: 'Claude identified bullish macro signal from news feed',
  ts: Date.now(),
}));
```

The core will:
1. Validate `size` against `riskLimits.maxClip` and `dailyLossStop`
2. If valid → broadcast `intent` + (if autonomy=AUTO) `decision`
3. If invalid → silently drop (agent remains in current state; no broadcast)

---

## Submitting Decisions (AUTO autonomy only)

Only AUTO agents may submit `decision` messages. The core validates `riskChecked` and re-applies risk limits. If the external agent's `riskChecked` is `false`, the core overrides with its own risk gate.

```javascript
ws.send(JSON.stringify({
  type: 'decision',
  agentId: 'TKT-001',      // Dealing Director (AUTO)
  role: 'Dealing Director',
  symbol: 'ETH-USDT',
  action: 'SELL',
  size: 3,
  price: 2683.12,
  rationale: 'Mean reversion after 3σ move',
  riskChecked: true,
  ts: Date.now(),
}));
```

If `riskChecked` is `false` or the decision exceeds risk limits, the core will:
- Override `riskChecked: false`
- Clip `size` to `maxClip`
- Reject if `dailyLossStop` would be exceeded
- Broadcast the decision with `riskChecked: true` (core-applied) or drop it

---

## HALT ALL Gate

External agents can request a full floor halt:

```javascript
ws.send(JSON.stringify({ type: 'halt_all' }));
```

The core responds by setting all 8 agents to `state: 'halted'` and broadcasting `lifecycle` messages with `status: 'halted'`. The external agent's WS connection receives these broadcasts just like any other client.

---

## Security & Compliance

- **No secrets in browser/WS** — all API keys, credentials remain server-side in core
- **Demo mode enforcement** — core never sends real orders; all decisions are simulated unless the operator explicitly lifts the demo gate (ops-only)
- **Rate limiting** — WS messages > 10/sec are dropped with a `rate_limited` log entry
- **Origin guard** — the WS endpoint only accepts connections from `localhost` and `127.0.0.1`; remote hosts must connect through an authenticated proxy (not yet implemented; remote access requires a ticket to the ops team)
- **Audit logging** — every inbound `intent`/`decision` from an external agent is logged with `agentId`, `timestamp`, `rationale`, and `riskChecked` status. Logs are available at `/var/log/hermes/agent-mcp.log` (Docker: `/hermes/logs/agent-mcp.log`)

---

## MCP Bridge Template (Node.js)

A minimal bridge that translates between MCP JSON-RPC and the Hermes WS protocol:

```javascript
// mcp-bridge.js
const WebSocket = require('ws');
const http = require('http');

const coreWs = new WebSocket('ws://localhost:4000/agents');
const clientWs = new WebSocket('ws://localhost:9876'); // upstream client connection

clientWs.on('message', (data) => {
  const msg = JSON.parse(data);
  // Translate MCP schema → Hermes schema
  if (msg.type === 'submit_intent') {
    coreWs.send(JSON.stringify({
      type: 'intent',
      agentId: msg.agentId,
      role: msg.role,
      symbol: msg.symbol,
      side: msg.side,
      size: msg.size,
      confidence: msg.confidence,
      rationale: msg.rationale,
      ts: Date.now(),
    }));
  }
  if (msg.type === 'submit_decision') {
    coreWs.send(JSON.stringify({
      type: 'decision',
      agentId: msg.agentId,
      role: msg.role,
      symbol: msg.symbol,
      action: msg.action,
      size: msg.size,
      price: msg.price,
      rationale: msg.rationale,
      riskChecked: msg.riskChecked,
      ts: Date.now(),
    }));
  }
  if (msg.type === 'halt_all') {
    coreWs.send(JSON.stringify({ type: 'halt_all' }));
  }
});

coreWs.on('message', (data) => {
  const msg = JSON.parse(data);
  // Translate Hermes schema → MCP schema
  if (msg.type === 'decision' || msg.type === 'intent') {
    clientWs.send(JSON.stringify({
      type: msg.type,
      agentId: msg.agentId,
      role: msg.role,
      symbol: msg.symbol,
      ...(msg.type === 'decision' ? {
        action: msg.action,
        size: msg.size,
        price: msg.price,
        riskChecked: msg.riskChecked,
      } : {
        side: msg.side,
        confidence: msg.confidence,
      }),
      rationale: msg.rationale,
      ts: msg.ts,
    }));
  }
  if (msg.type === 'lifecycle') {
    clientWs.send(JSON.stringify({
      type: 'lifecycle',
      agentId: msg.agentId,
      role: msg.role,
      status: msg.status,
      ts: msg.ts,
    }));
  }
});
```

---

## Usage Checklist

- [ ] Deploy the MCP bridge as a local process or Docker service
- [ ] Verify `ws://localhost:4000/agents` is reachable from the bridge host
- [ ] Test `subscribe` with a known `agentId` (TKT-001 through TKT-008)
- [ ] Submit a `intent` from an external agent; verify it appears in the desk UI Roster
- [ ] Submit a `decision` from an AUTO agent; verify it appears in the blotter
- [ ] Trigger `halt_all`; verify all 8 agents transition to `halted` state
- [ ] Check audit logs at `/hermes/logs/agent-mcp.log` (Docker) or `/var/log/hermes/agent-mcp.log` (native)
- [ ] Confirm no real orders are sent (demo mode enforced)

---

## Remote Deployment (future)

Currently the `/agents` WS is localhost-only. Remote deployment requires:
1. An authenticated TLS WS proxy (TBD — ops ticket required)
2. Rate-limited forwarding to `ws://localhost:4000/agents`
3. Agent identity binding (each external agent gets a unique `agentId` mapped to a core-approved config)

For now, run the MCP bridge on the same host as the core, or connect via `ssh -L 9876:localhost:4000` tunneling.

---

## Notes

- The core enforces that **only** the 4 AUTO agents (TKT-001, TKT-002, TKT-003, TKT-004) may emit `decision` messages. SUGGEST agents (TKT-005..TKT-008) that submit `decision` will have `riskChecked` overridden and the decision broadcast with `riskChecked: true` (core-applied) or dropped.
- The core's risk limits (from `agentSeed.ts`) are immutable via the MCP bridge — `maxClip`, `maxLeverage`, `dailyLossStop` are read-only for external agents.
- The desk UI (Roster + Blotter) updates in real-time from the `/agents` WS feed, so external-agent activity is immediately visible to the human operator.