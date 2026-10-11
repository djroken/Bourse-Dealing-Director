import { AgentConfigSchema } from "./agent.schema";
import type { AgentConfig } from "./agent.schema";

export const defaultAgents: AgentConfig[] = [
  {
    name: "Dealing Director",
    role: "Dealing Director",
    model: "anthropic/claude-3-opus",
    temperature: 0.5,
    autonomy: "AUTO",
    mandate: "Oversee the floor, ensure agent coordination, and make high-level decisions.",
    riskLimits: {
      maxClip: 10,
      maxLeverage: 5,
      dailyLossStop: 1000
    },
    tools: ["get_quotes", "get_positions", "read_floor"],
    feeds: ["market_data", "news"]
  },
  {
    name: "Execution Trader",
    role: "Execution Trader",
    model: "anthropic/claude-3-sonnet",
    temperature: 0.3,
    autonomy: "AUTO",
    mandate: "Execute trades based on agent intents and manage order lifecycle.",
    riskLimits: {
      maxClip: 5,
      maxLeverage: 10,
      dailyLossStop: 500
    },
    tools: ["place_order", "cancel_order", "get_positions"],
    feeds: ["market_data"]
  },
  {
    name: "Market Maker",
    role: "Market Maker",
    model: "anthropic/claude-3-haiku",
    temperature: 0.7,
    autonomy: "AUTO",
    mandate: "Provide liquidity by placing limit orders and capturing spreads.",
    riskLimits: {
      maxClip: 20,
      maxLeverage: 2,
      dailyLossStop: 200
    },
    tools: ["get_quotes", "place_order", "cancel_order"],
    feeds: ["market_data", "funding"]
  },
  {
    name: "Quant/Signals",
    role: "Quant/Signals",
    model: "anthropic/claude-3-sonnet",
    temperature: 0.4,
    autonomy: "AUTO",
    mandate: "Generate trading signals using statistical and machine learning models.",
    riskLimits: {
      maxClip: 5,
      maxLeverage: 5,
      dailyLossStop: 300
    },
    tools: ["get_quotes", "read_floor"],
    feeds: ["market_data", "on_chain"]
  },
  {
    name: "Research/News",
    role: "Research/News",
    model: "anthropic/claude-3-opus",
    temperature: 0.6,
    autonomy: "SUGGEST",
    mandate: "Analyze news and events to produce actionable insights for the floor.",
    riskLimits: {
      maxClip: 2,
      maxLeverage: 1,
      dailyLossStop: 50
    },
    tools: ["web_search"],
    feeds: ["news"]
  },
  {
    name: "On-chain Analyst",
    role: "On-chain Analyst",
    model: "anthropic/claude-3-sonnet",
    temperature: 0.5,
    autonomy: "SUGGEST",
    mandate: "Monitor blockchain activity and detect relevant on-chain signals.",
    riskLimits: {
      maxClip: 2,
      maxLeverage: 1,
      dailyLossStop: 50
    },
    tools: ["web_search"],
    feeds: ["on_chain"]
  },
  {
    name: "Risk Officer",
    role: "Risk Officer",
    model: "anthropic/claude-3-opus",
    temperature: 0.2,
    autonomy: "SUGGEST",
    mandate: "Monitor risk metrics and veto intents that exceed risk limits.",
    riskLimits: {
      maxClip: 1,
      maxLeverage: 1,
      dailyLossStop: 5000
    },
    tools: ["get_risk", "read_floor"],
    feeds: ["market_data", "news"]
  },
  {
    name: "Sentiment",
    role: "Sentiment",
    model: "anthropic/claude-3-haiku",
    temperature: 0.5,
    autonomy: "SUGGEST",
    mandate: "Analyze market sentiment from social media and news.",
    riskLimits: {
      maxClip: 2,
      maxLeverage: 1,
      dailyLossStop: 50
    },
    tools: ["web_search"],
    feeds: ["news"]
  }
];
