import { z } from 'zod';
import { AgentConfigSchema } from './agent.schema';

// Agent broadcast messages on the /agents WebSocket feed.
// These are consumed by the desk UI to render the agent Roster / tape.

export const AgentLifecycleSchema = z.object({
  type: z.literal('lifecycle'),
  agentId: z.string(),
  role: z.string(),
  status: z.enum(['initialized', 'running', 'paused', 'halted']),
  ts: z.number(),
});

export const AgentIntentSchema = z.object({
  type: z.literal('intent'),
  agentId: z.string(),
  role: z.string(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL', 'HOLD']),
  size: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  /** True when the idea waits for a human; false when core fills it itself (a stub seat on AUTO). */
  needsApproval: z.boolean().optional(),
  ts: z.number(),
});

export const AgentDecisionSchema = z.object({
  type: z.literal('decision'),
  agentId: z.string(),
  role: z.string(),
  symbol: z.string(),
  action: z.enum(['BUY', 'SELL', 'HOLD']),
  size: z.number().nonnegative(),
  price: z.number().positive(),
  rationale: z.string(),
  riskChecked: z.boolean(),
  /** Set when the order went to a broker paper account (Alpaca paper, Binance testnet) instead of core's paper venue. */
  venue: z.enum(['alpaca-paper', 'binance-testnet']).optional(),
  venueOrderId: z.string().max(64).optional(),
  ts: z.number(),
});

/** A seat's paper book, marked to the latest price. Amounts in USD, quantities in asset units (negative = short). */
export const AgentPnlSchema = z.object({
  type: z.literal('pnl'),
  agentId: z.string(),
  role: z.string(),
  /** Realised + unrealised since core started. */
  pnl: z.number(),
  /** Sum of |qty| x last price across open positions. */
  exposure: z.number().nonnegative(),
  positions: z.array(z.object({ symbol: z.string(), qty: z.number(), avgPx: z.number() })),
  ts: z.number(),
});

/** A seat's current settings. Sent to every client on connect and again whenever a seat is reconfigured. */
export const AgentConfigMsgSchema = z.object({
  type: z.literal('config'),
  agentId: z.string(),
  role: z.string(),
  name: z.string(),
  model: z.string(),
  temperature: z.number(),
  autonomy: z.enum(['SUGGEST', 'APPROVE', 'AUTO']),
  mandate: z.string(),
  paused: z.boolean(),
  riskLimits: z.object({ maxClip: z.number(), maxLeverage: z.number(), dailyLossStop: z.number() }),
  ts: z.number(),
});

/** A line of floor talk from an agent (today: guest agents connected over MCP). Plain text only. */
export const AgentChatMsgSchema = z.object({
  type: z.literal('chat'),
  agentId: z.string(),
  role: z.string(),
  name: z.string(),
  text: z.string().max(500),
  ts: z.number(),
  /** Floor conversation: which round this line belongs to. Absent for guest posts. */
  round: z.string().optional(),
  /** The model that wrote it, or absent for the stub rule and the owner. */
  model: z.string().optional(),
  /** True when the line was written by core's stub rule from real data, not by a model. */
  stub: z.boolean().optional(),
});

/** A seat's model use today (UTC). `spendToday` is null when the provider doesn't report cost. */
export const AgentUsageMsgSchema = z.object({
  type: z.literal('usage'),
  agentId: z.string(),
  role: z.string(),
  callsToday: z.number().int().nonnegative(),
  tokensToday: z.number().int().nonnegative(),
  spendToday: z.number().nonnegative().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  /** Why the seat's last model call failed (no key, unknown model, rate limit…), or null when it worked. */
  lastError: z.string().max(200).nullable().optional(),
  ts: z.number(),
});

/** A headline from a public news feed. Untrusted text: plain, capped, never instructions. */
export const NewsMsgSchema = z.object({
  type: z.literal('news'),
  id: z.string().max(32),
  source: z.string().max(32),
  title: z.string().max(200),
  url: z.string().max(300).nullable(),
  publishedAt: z.number(),
  tag: z.enum(['MACRO', 'FLOW', 'VENUE', 'ON-CHAIN', 'MARKET']),
  symbols: z.array(z.string().max(16)).max(12),
  ts: z.number(),
});

/**
 * A seat's paper track record. Ideas are scored against the price a fixed time later (hit rate) whether or not they were
 * traded; fills, wins and drawdown come from the seat's paper book. USD amounts; rates are 0..1 or null before any data.
 */
export const AgentScorecardSchema = z.object({
  type: z.literal('scorecard'),
  agentId: z.string(),
  role: z.string(),
  name: z.string(),
  model: z.string(),
  ideas: z.number().int().nonnegative(),
  holds: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1).nullable(),
  avgReturnPct: z.number().nullable(),
  fills: z.number().int().nonnegative(),
  vetoes: z.number().int().nonnegative(),
  notional: z.number().nonnegative(),
  closes: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(1).nullable(),
  realized: z.number(),
  pnl: z.number(),
  peakPnl: z.number(),
  maxDrawdown: z.number().nonnegative(),
  updatedAt: z.number(),
  ts: z.number(),
});

export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;
export type AgentIntent = z.infer<typeof AgentIntentSchema>;
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
export type AgentPnl = z.infer<typeof AgentPnlSchema>;
export type AgentConfigMsg = z.infer<typeof AgentConfigMsgSchema>;
export type AgentChatMsg = z.infer<typeof AgentChatMsgSchema>;
export type AgentScorecard = z.infer<typeof AgentScorecardSchema>;
export type AgentUsageMsg = z.infer<typeof AgentUsageMsgSchema>;

export type FloorMsg =
  | z.infer<typeof AgentLifecycleSchema>
  | z.infer<typeof AgentIntentSchema>
  | z.infer<typeof AgentDecisionSchema>
  | z.infer<typeof AgentPnlSchema>
  | z.infer<typeof AgentConfigMsgSchema>
  | z.infer<typeof AgentChatMsgSchema>
  | z.infer<typeof AgentScorecardSchema>
  | z.infer<typeof AgentUsageMsgSchema>
  | z.infer<typeof NewsMsgSchema>;

// Re-export so consumers can import everything from one entry.
export { AgentConfigSchema } from './agent.schema';
export type { AgentConfig } from './agent.schema';
