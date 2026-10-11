// Static content and types for the Desk, ported from the v2 prototype.
// SEED_AGENTS / SCRIPT / FILL_TPL are the simulated floor (what the prototype fakes);
// they get replaced by Hermes Core streams as the backend milestones land.

export type Grp = "dir" | "exec" | "res" | "risk" | "quant";
export type Autonomy = "SUGGEST" | "APPROVE" | "AUTO";
export type Side = "BUY" | "SELL";
export type Mode = "demo" | "live";

export const TINTS: Record<Grp, string> = {
  dir: "var(--cFF9E2C)",
  exec: "var(--cE1E7ED)",
  res: "var(--cFFC078)",
  risk: "var(--cFF8E8E)",
  quant: "var(--c9AA5B1)",
};

export const MODELS = [
  "claude-opus-4.5", "claude-sonnet-4.5", "claude-haiku-4.5", "gpt-5.1", "o4-mini",
  "gemini-2.5-pro", "llama-4-405b", "mistral-large-2", "deepseek-v3", "qwen3 (ollama, local)",
];
export const AUTONOMY: Autonomy[] = ["SUGGEST", "APPROVE", "AUTO"];
export const ALL_TOOLS = ["orderbook", "perp-venues", "dex-router", "news-wire", "on-chain", "backtest", "twitter", "options-surface"];

export interface SeedAgent {
  name: string;
  role: string;
  grp: Grp;
  model: string;
  status: string;
  pnl: number;
  exposure: string;
  temp: number;
  autonomy: Autonomy;
  mandate: string;
  maxClip: string;
  leverage: string;
  lossStop: string;
  tokens: string;
  spend: string;
  latency: string;
  tools: string[];
}
export interface Agent extends SeedAgent {
  paused: boolean;
}

export const SEED_AGENTS: SeedAgent[] = [
  { name: "Vega Ostrowski", role: "DEALING DIRECTOR", grp: "dir", model: "claude-opus-4.5", status: "COORDINATING", pnl: 0, exposure: "—", temp: 0.3, autonomy: "APPROVE", mandate: "Own the floor's risk budget. Arbitrate between desks, size the house view, and escalate anything above 40% of daily VaR.", maxClip: "$2.5M", leverage: "3.0x", lossStop: "-$180k", tokens: "1.42M", spend: "$61.40", latency: "1.9s", tools: ["orderbook", "news-wire", "backtest"] },
  { name: "Atlas Reyner", role: "EXECUTION TRADER", grp: "exec", model: "gpt-5.1", status: "WORKING", pnl: 41280, exposure: "$1.84M", temp: 0.15, autonomy: "AUTO", mandate: "Work parent orders with minimal impact. Prefer passive fills; escalate if slippage exceeds 6bp of notional.", maxClip: "$900k", leverage: "5.0x", lossStop: "-$70k", tokens: "2.10M", spend: "$34.80", latency: "0.7s", tools: ["orderbook", "perp-venues", "dex-router"] },
  { name: "Kite Alvarez", role: "MARKET MAKER", grp: "exec", model: "claude-sonnet-4.5", status: "QUOTING", pnl: 12640, exposure: "$620k", temp: 0.1, autonomy: "AUTO", mandate: "Two-sided quotes on the top four perps. Widen on realised-vol spikes and never carry inventory through funding.", maxClip: "$400k", leverage: "4.0x", lossStop: "-$45k", tokens: "3.61M", spend: "$28.15", latency: "0.4s", tools: ["orderbook", "perp-venues", "options-surface"] },
  { name: "Pico Nandra", role: "QUANT / SIGNALS", grp: "quant", model: "o4-mini", status: "MODELLING", pnl: 8910, exposure: "$310k", temp: 0.2, autonomy: "SUGGEST", mandate: "Maintain the cross-sectional momentum and carry signals. Publish a ranked book every 15 minutes with confidence bands.", maxClip: "$500k", leverage: "2.0x", lossStop: "-$30k", tokens: "0.92M", spend: "$11.05", latency: "2.4s", tools: ["backtest", "on-chain", "orderbook"] },
  { name: "Sable Ito", role: "RESEARCH / NEWS", grp: "res", model: "claude-haiku-4.5", status: "READING", pnl: 0, exposure: "—", temp: 0.4, autonomy: "SUGGEST", mandate: "Read the wire and rank headlines by tradable impact. Push only what changes a position, with the source attached.", maxClip: "—", leverage: "—", lossStop: "—", tokens: "5.30M", spend: "$9.60", latency: "0.9s", tools: ["news-wire", "twitter"] },
  { name: "Ledger Voss", role: "ON-CHAIN ANALYST", grp: "res", model: "llama-4-405b", status: "SCANNING", pnl: 3050, exposure: "$95k", temp: 0.25, autonomy: "SUGGEST", mandate: "Watch large wallet flow, lending utilisation and bridge activity. Flag anything that moves a DeFi position's liquidation band.", maxClip: "$250k", leverage: "1.5x", lossStop: "-$20k", tokens: "1.75M", spend: "$14.20", latency: "3.1s", tools: ["on-chain", "dex-router"] },
  { name: "Bastion Cole", role: "RISK OFFICER", grp: "risk", model: "claude-opus-4.5", status: "MONITORING", pnl: 0, exposure: "—", temp: 0.05, autonomy: "APPROVE", mandate: "Hard veto on any breach of clip size, leverage or loss stop. Re-check portfolio VaR every tick and publish a breach log.", maxClip: "—", leverage: "—", lossStop: "-$180k", tokens: "1.18M", spend: "$52.90", latency: "1.1s", tools: ["orderbook", "backtest", "on-chain"] },
  { name: "Corva Lin", role: "SENTIMENT DESK", grp: "quant", model: "mistral-large-2", status: "LISTENING", pnl: -2140, exposure: "$140k", temp: 0.5, autonomy: "SUGGEST", mandate: "Score crowd positioning from social and funding data. Fade extremes; stay silent when the signal is inside noise bands.", maxClip: "$200k", leverage: "2.0x", lossStop: "-$15k", tokens: "4.08M", spend: "$7.35", latency: "1.4s", tools: ["twitter", "news-wire", "perp-venues"] },
];

/** Each agent's open position in the simulated book, indexed like SEED_AGENTS. */
export const POS: Array<{ k: string; q: number } | null> = [
  null, { k: "BTCUSDT", q: 14 }, { k: "SOLUSDT", q: 2600 }, { k: "ETHUSDT", q: 85 },
  null, { k: "ETHUSDT", q: 26 }, null, { k: "XRPUSDT", q: -48000 },
];

export interface TapeItem {
  k: string;
  label: string;
  dp: number;
  tv: string;
  cb: string | null;
  seed: number;
}
export const TAPE: TapeItem[] = [
  { k: "BTCUSDT", label: "BTC/USDT", dp: 0, tv: "BINANCE:BTCUSDT", cb: "BTC-USD", seed: 96400 },
  { k: "ETHUSDT", label: "ETH/USDT", dp: 1, tv: "BINANCE:ETHUSDT", cb: "ETH-USD", seed: 3420 },
  { k: "SOLUSDT", label: "SOL/USDT", dp: 2, tv: "BINANCE:SOLUSDT", cb: "SOL-USD", seed: 215 },
  { k: "BNBUSDT", label: "BNB/USDT", dp: 1, tv: "BINANCE:BNBUSDT", cb: null, seed: 640 },
  { k: "XRPUSDT", label: "XRP/USDT", dp: 4, tv: "BINANCE:XRPUSDT", cb: "XRP-USD", seed: 2.4 },
];
export const LBL: Record<string, TapeItem> = Object.fromEntries(TAPE.map((t) => [t.k, t]));
export const PERP = (k: string): string => k.replace("USDT", "-PERP");

export type ScriptEvent =
  | { who: number; kind: "msg"; text: string }
  | { who: number; kind: "sys"; text: string }
  | { who: number; kind: "trade"; side: Side; k: string; q: number }
  | { who: number; kind: "intent"; side: Side; k: string; q: number; why: string };

export const SCRIPT: ScriptEvent[] = [
  { who: 0, kind: "msg", text: "House view is unchanged: long crypto beta, hedged through the CPI print. Sable, anything on the wire that moves that?" },
  { who: 4, kind: "msg", text: "Core CPI came in a tick below consensus. Front-end yields lower, dollar offered. Risk-positive." },
  { who: 3, kind: "msg", text: "Momentum book re-ranks BTC and SOL to the top decile. Confidence 0.71, half-life about four hours." },
  { who: 0, kind: "msg", text: "Take it. Atlas, add 10% of NAV in BTC-PERP, passive, no more than 15% of top-of-book." },
  { who: 1, kind: "trade", side: "BUY", k: "BTCUSDT", q: 12.4 },
  { who: 6, kind: "msg", text: "Post-trade VaR at 31% of budget. Inside limits, but the perp sleeve is close to the leverage cap." },
  { who: 2, kind: "msg", text: "Widening my SOL quotes two ticks. Realised vol is up and I don't want inventory through the funding stamp." },
  { who: 5, kind: "msg", text: "Large ETH transfer from a dormant wallet into Aave. Borrow utilisation is climbing, so liquidation bands tighten for anyone levered above 4x." },
  { who: 5, kind: "intent", side: "SELL", k: "ETHUSDT", q: 40, why: "Trim ETH beta before lending utilisation tightens liquidation bands." },
  { who: 7, kind: "msg", text: "Funding is skewed long and social positioning is in the 88th percentile. I'd fade any further chase from here." },
  { who: 7, kind: "intent", side: "SELL", k: "BTCUSDT", q: 3, why: "Crowd long at the 88th percentile with funding skewed long. Small fade into strength." },
  { who: 0, kind: "msg", text: "Noted. Cap the add where it is and let Kite earn the spread instead." },
  { who: 1, kind: "trade", side: "SELL", k: "ETHUSDT", q: 180 },
  { who: 6, kind: "sys", text: "RISK · leverage reduced after ETH sale. No breaches on the session." },
  { who: 3, kind: "msg", text: "Carry signal flips negative on ETH in about 40 minutes if funding holds. I'll publish the updated book then." },
  { who: 3, kind: "intent", side: "BUY", k: "SOLUSDT", q: 900, why: "SOL ranks top decile on momentum and carry is positive. Confidence 0.68." },
  { who: 4, kind: "msg", text: "ETF complex printed another day of net creations. Supportive, but largely in the price." },
  { who: 2, kind: "trade", side: "BUY", k: "SOLUSDT", q: 1450 },
  { who: 0, kind: "msg", text: "Good. Flatten residual delta by the close and write the day up for the morning meeting." },
];

export interface FillTpl {
  side: Side;
  k: string;
  q: number;
  agent: string;
  ago: number;
  off: number;
}
export const FILL_TPL: FillTpl[] = [
  { side: "BUY", k: "BTCUSDT", q: 12.4, agent: "Atlas Reyner", ago: 420, off: -0.0021 },
  { side: "SELL", k: "ETHUSDT", q: 180, agent: "Atlas Reyner", ago: 680, off: 0.0016 },
  { side: "BUY", k: "SOLUSDT", q: 1450, agent: "Kite Alvarez", ago: 1050, off: -0.0034 },
  { side: "SELL", k: "BTCUSDT", q: 4, agent: "Kite Alvarez", ago: 1610, off: 0.0012 },
  { side: "SELL", k: "XRPUSDT", q: 30000, agent: "Corva Lin", ago: 2240, off: 0.0025 },
  { side: "BUY", k: "ETHUSDT", q: 120, agent: "Atlas Reyner", ago: 2790, off: -0.0041 },
  { side: "SELL", k: "SOLUSDT", q: 900, agent: "Kite Alvarez", ago: 3300, off: 0.0019 },
  { side: "BUY", k: "BNBUSDT", q: 400, agent: "Pico Nandra", ago: 3920, off: -0.0012 },
];

export interface NewsItem {
  tag: "MACRO" | "ON-CHAIN" | "FLOW" | "VENUE";
  age: string;
  headline: string;
  agent: string;
  impact: "HIGH" | "MED" | "LOW";
}
/** Static in the prototype. Wire to Finnhub / a news provider in the data milestone. */
export const NEWS: NewsItem[] = [
  { tag: "MACRO", age: "2m", headline: "Core CPI prints 0.2% m/m, one tick below consensus; front-end yields fall 6bp", agent: "Sable", impact: "HIGH" },
  { tag: "ON-CHAIN", age: "9m", headline: "2,400 ETH moved from a dormant wallet into Aave; borrow utilisation up to 71%", agent: "Ledger", impact: "MED" },
  { tag: "FLOW", age: "14m", headline: "Spot BTC ETF complex takes in $310m, third consecutive session of net creations", agent: "Corva", impact: "MED" },
  { tag: "VENUE", age: "27m", headline: "Perp maker rebates cut 0.1bp at two venues; Kite re-quoting on the wider tier", agent: "Kite", impact: "LOW" },
];

/** Persisted setup. The onboarding flow (milestone 4) will own writing this server-side. */
export interface Setup {
  done: boolean;
  runtime: string;
  on: Record<string, boolean>;
  vals: Record<string, string>;
  agentsOn: boolean[];
  autonomy: Autonomy;
  capital: string;
  lossStop: string;
  lev: string;
}
/**
 * Live trading is not implemented: nothing in this repo can place a real order.
 * Every path to Live mode is gated on this flag. Flip it only together with a real execution
 * layer (venue adapters, server-side key storage, a hard risk gate) and tests for them.
 */
export const LIVE_AVAILABLE = false;
export const APP_VERSION = "0.1";

export const SETUP_KEY = "hermes.setup.v1";
export const DEFAULT_SETUP: Setup = {
  done: false,
  runtime: "hermes",
  vals: {},
  on: {
    "model.anthropic": true, "data.binance": true, "data.coinbase": true, "data.hyperliquid": true,
    "data.defillama": true, "data.frankfurter": true, "data.tradingview": true, "venue.paper": true,
  },
  agentsOn: [true, true, true, true, true, true, true, true],
  autonomy: "APPROVE",
  capital: "100000",
  lossStop: "2500",
  lev: "3",
};

export const RUNTIME_NAMES: Record<string, string> = {
  hermes: "Hermes native", claude: "Claude", openai: "OpenAI", openclaw: "OpenClaw", mcp: "MCP server", http: "Custom HTTP",
};

/** Venues that can unlock Live. `field` is the first credential field; Live needs it non-empty. */
export const VENUES: Array<{ id: string; name: string; field: string }> = [
  { id: "binance", name: "Binance", field: "key" },
  { id: "bybit", name: "Bybit", field: "key" },
  { id: "hyperliquid", name: "Hyperliquid", field: "addr" },
  { id: "coinbase", name: "Coinbase Advanced", field: "key" },
  { id: "alpaca", name: "Alpaca", field: "key" },
  { id: "ibkr", name: "Interactive Brokers", field: "url" },
  { id: "wallet", name: "EVM wallet", field: "addr" },
];

export const AUTO_DESC: Record<Autonomy, string> = {
  SUGGEST: "Agents propose, you place the order",
  APPROVE: "Agents place after your OK",
  AUTO: "Agents trade inside risk limits",
};
