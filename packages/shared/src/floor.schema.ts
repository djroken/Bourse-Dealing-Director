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
});

export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;
export type AgentIntent = z.infer<typeof AgentIntentSchema>;
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
export type AgentPnl = z.infer<typeof AgentPnlSchema>;
export type AgentConfigMsg = z.infer<typeof AgentConfigMsgSchema>;
export type AgentChatMsg = z.infer<typeof AgentChatMsgSchema>;

export type FloorMsg =
  | z.infer<typeof AgentLifecycleSchema>
  | z.infer<typeof AgentIntentSchema>
  | z.infer<typeof AgentDecisionSchema>
  | z.infer<typeof AgentPnlSchema>
  | z.infer<typeof AgentConfigMsgSchema>
  | z.infer<typeof AgentChatMsgSchema>;

// Re-export so consumers can import everything from one entry.
export { AgentConfigSchema } from './agent.schema';
export type { AgentConfig } from './agent.schema';
