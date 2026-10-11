import type { Setup } from "./data";

export interface OnbField {
  k: string;
  label: string;
  ph: string;
  type: "text" | "password";
  /** Default value shown when the user hasn't typed anything. */
  v?: string;
  ro?: boolean;
}
export interface OnbItem {
  id: string;
  name: string;
  tag: string;
  desc: string;
  fields: OnbField[];
  /** Always on and not toggleable (the paper venue). */
  locked?: boolean;
}
export interface OnbStep {
  id: "runtime" | "model" | "data" | "venue";
  num: string;
  label: string;
  sub: string;
  title: string;
  desc: string;
  single?: boolean;
  items: OnbItem[];
}

const F = (k: string, label: string, ph: string, type: "text" | "password" = "text", extra: Partial<OnbField> = {}): OnbField => ({
  k, label, ph, type, ...extra,
});
const KEY = (ph: string): OnbField[] => [F("key", "API KEY", ph, "password")];
const KEYSEC = (): OnbField[] => [
  F("key", "API KEY", "Trade-enabled key, no withdrawals", "password"),
  F("secret", "API SECRET", "••••••••", "password"),
];

export const STEPS: OnbStep[] = [
  {
    id: "runtime", num: "01", label: "Agent runtime", sub: "Where the agents think", single: true,
    title: "Connect an agent runtime",
    desc: "Hermes can run the floor itself, or plug into an agent you already use. Pick one now; you can switch any time from Setup.",
    items: [
      { id: "hermes", name: "Hermes native", tag: "DEFAULT", desc: "Built-in orchestrator. Each agent runs on the model provider you add in the next step.", fields: [] },
      { id: "claude", name: "Claude", tag: "API KEY", desc: "Run the floor on Claude through the Messages API, with tool use for quotes and orders.", fields: KEY("sk-ant-…") },
      { id: "openai", name: "OpenAI", tag: "API KEY", desc: "Responses API with function calling. Works with GPT and o-series models.", fields: KEY("sk-…") },
      { id: "openclaw", name: "OpenClaw", tag: "ENDPOINT", desc: "Point at a running OpenClaw gateway. Hermes registers the desk as a skill.", fields: [F("url", "GATEWAY URL", "https://your-openclaw-host"), F("token", "TOKEN", "••••••••", "password")] },
      { id: "mcp", name: "MCP server", tag: "ENDPOINT", desc: "Any MCP-capable agent. Hermes exposes quotes, orders and the floor chat as tools.", fields: [F("url", "SERVER URL", "https://…/mcp"), F("token", "BEARER TOKEN", "••••••••", "password")] },
      { id: "http", name: "Custom HTTP", tag: "WEBHOOK", desc: "Your own agent. Hermes POSTs floor state each tick; you reply with decisions as JSON.", fields: [F("url", "WEBHOOK URL", "https://your-agent/decide"), F("secret", "SIGNING SECRET", "••••••••", "password")] },
    ],
  },
  {
    id: "model", num: "02", label: "Model providers", sub: "Keys for each brain",
    title: "Add model providers",
    desc: "Every agent picks its own model. Add the providers you want available and mix them across the floor.",
    items: [
      { id: "anthropic", name: "Anthropic", tag: "API KEY", desc: "Claude Opus, Sonnet and Haiku. Good default for the director and risk seats.", fields: KEY("sk-ant-…") },
      { id: "openai", name: "OpenAI", tag: "API KEY", desc: "GPT and o-series reasoning models.", fields: KEY("sk-…") },
      { id: "openrouter", name: "OpenRouter", tag: "API KEY", desc: "One key for hundreds of models, including Llama, Mistral, DeepSeek and Qwen.", fields: KEY("sk-or-…") },
      { id: "google", name: "Google Gemini", tag: "API KEY", desc: "Gemini models with long context, useful for research and news seats.", fields: KEY("AIza…") },
      { id: "ollama", name: "Ollama", tag: "LOCAL · NO KEY", desc: "Run open models on your own machine. Zero token cost, higher latency.", fields: [F("host", "HOST", "http://localhost:11434", "text", { v: "http://localhost:11434" })] },
      { id: "deepseek", name: "DeepSeek", tag: "API KEY", desc: "Low-cost reasoning models for high-frequency seats like market making.", fields: KEY("sk-…") },
    ],
  },
  {
    id: "data", num: "03", label: "Market data", sub: "Prices, news, charts",
    title: "Choose market data",
    desc: "Demo and Live both run on real prices. The free feeds need no key and are on by default. Add keyed feeds for equities, FX and news.",
    items: [
      { id: "binance", name: "Binance public", tag: "FREE · NO KEY", desc: "Spot and perp prices, candles and funding from the public market-data API.", fields: [] },
      { id: "coinbase", name: "Coinbase Exchange", tag: "FREE · NO KEY", desc: "Spot prices and candles. Used automatically where Binance is restricted.", fields: [] },
      { id: "hyperliquid", name: "Hyperliquid", tag: "FREE · NO KEY", desc: "Perp prices, funding and open interest from the public info endpoint.", fields: [] },
      { id: "defillama", name: "DefiLlama", tag: "FREE · NO KEY", desc: "TVL, yields, stablecoin supply and DEX volume for the DeFi seats.", fields: [] },
      { id: "frankfurter", name: "Frankfurter FX", tag: "FREE · NO KEY", desc: "ECB reference FX rates, published daily.", fields: [] },
      { id: "coingecko", name: "CoinGecko", tag: "FREE TIER", desc: "Prices and market caps for long-tail tokens. Demo key optional.", fields: [F("key", "DEMO KEY (OPTIONAL)", "CG-…", "password")] },
      { id: "finnhub", name: "Finnhub", tag: "FREE KEY", desc: "US equities, company news and the earnings calendar.", fields: KEY("Finnhub token") },
      { id: "twelvedata", name: "Twelve Data", tag: "FREE KEY", desc: "Equities, FX, ETFs and indices across global exchanges.", fields: KEY("Twelve Data key") },
      { id: "tradingview", name: "TradingView", tag: "CHARTS + ALERTS", desc: "TradingView charts on the desk. Point TradingView alerts at the webhook below to send signals to the floor.", fields: [F("hook", "ALERT WEBHOOK URL", "", "text", { v: "https://<your-hermes-host>/hooks/tradingview", ro: true }), F("pass", "ALERT PASSPHRASE", "Set a shared secret", "password")] },
    ],
  },
  {
    id: "venue", num: "04", label: "Venues & wallets", sub: "Only needed for Live",
    title: "Connect venues",
    desc: "Demo trades a paper book against live prices. To trade live, connect at least one venue with trade-only keys. Hermes never needs withdrawal permission.",
    items: [
      { id: "paper", name: "Paper venue", tag: "DEFAULT", desc: "Simulated fills at the live mid. Always on in Demo.", fields: [], locked: true },
      { id: "binance", name: "Binance", tag: "API KEY", desc: "Spot and USDⓈ-M perpetuals.", fields: KEYSEC() },
      { id: "bybit", name: "Bybit", tag: "API KEY", desc: "Spot, perps and options on the unified account.", fields: KEYSEC() },
      { id: "hyperliquid", name: "Hyperliquid", tag: "API WALLET", desc: "On-chain perps. Use an API wallet so the main key never leaves your device.", fields: [F("addr", "ACCOUNT ADDRESS", "0x…"), F("key", "API WALLET KEY", "Trade-only agent key", "password")] },
      { id: "coinbase", name: "Coinbase Advanced", tag: "API KEY", desc: "Spot trading on Coinbase Advanced.", fields: KEYSEC() },
      { id: "alpaca", name: "Alpaca", tag: "API KEY", desc: "US equities and ETFs. Paper and live accounts.", fields: KEYSEC() },
      { id: "ibkr", name: "Interactive Brokers", tag: "GATEWAY", desc: "Global multi-asset through the Client Portal gateway running on your machine.", fields: [F("url", "GATEWAY URL", "https://localhost:5000")] },
      { id: "wallet", name: "EVM wallet", tag: "WALLET", desc: "On-chain swaps from a dedicated hot wallet. Fund it with only what you intend to trade.", fields: [F("addr", "WALLET ADDRESS", "0x…")] },
    ],
  },
];

export const STEP_COUNT = 6; // four item steps + Floor & risk + Review
export const RISK_STEP = 4;
export const REVIEW_STEP = 5;
export const VENUE_STEP = 3;

export const STEP_RAIL: Array<{ num: string; label: string; sub: string }> = [
  ...STEPS.map((s) => ({ num: s.num, label: s.label, sub: s.sub })),
  { num: "05", label: "Floor & risk", sub: "Seats, autonomy, limits" },
  { num: "06", label: "Review & launch", sub: "Check and go" },
];

export const MCP_TOOLS = ["get_quotes", "get_positions", "place_order", "cancel_order", "get_risk", "read_floor", "post_to_floor"];
export const MCP_SNIPPET = `{
  "mcpServers": {
    "hermes": {
      "command": "npx",
      "args": ["-y", "hermes-desk", "mcp"],
      "env": { "HERMES_URL": "http://localhost:4000" }
    }
  }
}`;

export const keyOf = (step: OnbStep, it: OnbItem): string => step.id + "." + it.id;
export const valKey = (step: OnbStep, it: OnbItem, f: OnbField): string => keyOf(step, it) + "." + f.k;

/** Secrets never go to localStorage: a password-type field's value lives in memory for this tab only. */
const SECRET_VAL_KEYS: Set<string> = new Set(
  STEPS.flatMap((st) => st.items.flatMap((it) => it.fields.filter((f) => f.type === "password").map((f) => valKey(st, it, f)))),
);
export const isSecretVal = (k: string): boolean => SECRET_VAL_KEYS.has(k);

/** The copy of setup that is safe to persist in the browser. */
export function persistable(setup: Setup): Setup {
  const vals: Record<string, string> = {};
  for (const [k, v] of Object.entries(setup.vals)) if (!isSecretVal(k)) vals[k] = v;
  return { ...setup, vals };
}
