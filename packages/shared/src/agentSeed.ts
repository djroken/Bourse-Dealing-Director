import { AgentConfigSchema } from "./agent.schema";
import type { AgentConfig } from "./agent.schema";

/**
 * The eight seats. Name, role, model, temperature, autonomy and mandate mirror the Desk's roster in
 * apps/web/lib/desk/data.ts (a web test keeps them in step); risk limits and tools are core's own, in asset units.
 */
export const defaultAgents: AgentConfig[] = [
  {
    name: "Vega Ostrowski",
    role: "Dealing Director",
    model: "claude-opus-4.5",
    temperature: 0.3,
    autonomy: "APPROVE",
    trades: false,
    mandate: "Own the floor's risk budget. Arbitrate between desks, size the house view, and escalate anything above 40% of daily VaR.",
    riskLimits: {
      maxClip: 10,
      maxLeverage: 5,
      dailyLossStop: 1000
    },
    tools: ["get_quotes", "get_positions", "read_floor"],
    feeds: ["market_data", "news"]
  },
  {
    name: "Atlas Reyner",
    role: "Execution Trader",
    model: "gpt-5.1",
    temperature: 0.15,
    autonomy: "AUTO",
    trades: true,
    mandate: "Work parent orders with minimal impact. Prefer passive fills; escalate if slippage exceeds 6bp of notional.",
    riskLimits: {
      maxClip: 5,
      maxLeverage: 10,
      dailyLossStop: 500
    },
    tools: ["place_order", "cancel_order", "get_positions"],
    feeds: ["market_data"]
  },
  {
    name: "Kite Alvarez",
    role: "Market Maker",
    model: "claude-sonnet-4.5",
    temperature: 0.1,
    autonomy: "AUTO",
    trades: true,
    mandate: "Two-sided quotes on the top four perps. Widen on realised-vol spikes and never carry inventory through funding.",
    riskLimits: {
      maxClip: 20,
      maxLeverage: 2,
      dailyLossStop: 200
    },
    tools: ["get_quotes", "place_order", "cancel_order"],
    feeds: ["market_data", "funding"]
  },
  {
    name: "Pico Nandra",
    role: "Quant / Signals",
    model: "o4-mini",
    temperature: 0.2,
    autonomy: "SUGGEST",
    trades: true,
    mandate: "Maintain the cross-sectional momentum and carry signals. Publish a ranked book every 15 minutes with confidence bands.",
    riskLimits: {
      maxClip: 5,
      maxLeverage: 5,
      dailyLossStop: 300
    },
    tools: ["get_quotes", "read_floor"],
    feeds: ["market_data", "on_chain"]
  },
  {
    name: "Sable Ito",
    role: "Research / News",
    model: "claude-haiku-4.5",
    temperature: 0.4,
    autonomy: "SUGGEST",
    trades: false,
    mandate: "Read the wire and rank headlines by tradable impact. Push only what changes a position, with the source attached.",
    riskLimits: {
      maxClip: 2,
      maxLeverage: 1,
      dailyLossStop: 50
    },
    tools: ["web_search"],
    feeds: ["news"]
  },
  {
    name: "Ledger Voss",
    role: "On-chain Analyst",
    model: "llama-4-405b",
    temperature: 0.25,
    autonomy: "SUGGEST",
    trades: false,
    mandate: "Watch large wallet flow, lending utilisation and bridge activity. Flag anything that moves a DeFi position's liquidation band.",
    riskLimits: {
      maxClip: 2,
      maxLeverage: 1,
      dailyLossStop: 50
    },
    tools: ["web_search"],
    feeds: ["on_chain"]
  },
  {
    name: "Bastion Cole",
    role: "Risk Officer",
    model: "claude-opus-4.5",
    temperature: 0.05,
    autonomy: "APPROVE",
    trades: false,
    mandate: "Hard veto on any breach of clip size, leverage or loss stop. Re-check portfolio VaR every tick and publish a breach log.",
    riskLimits: {
      maxClip: 1,
      maxLeverage: 1,
      dailyLossStop: 5000
    },
    tools: ["get_risk", "read_floor"],
    feeds: ["market_data", "news"]
  },
  {
    name: "Corva Lin",
    role: "Sentiment Desk",
    model: "mistral-large-2",
    temperature: 0.5,
    autonomy: "SUGGEST",
    trades: true,
    mandate: "Score crowd positioning from social and funding data. Fade extremes; stay silent when the signal is inside noise bands.",
    riskLimits: {
      maxClip: 2,
      maxLeverage: 1,
      dailyLossStop: 50
    },
    tools: ["web_search"],
    feeds: ["news"]
  }
];
