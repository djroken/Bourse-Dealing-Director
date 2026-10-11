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

export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;
export type AgentIntent = z.infer<typeof AgentIntentSchema>;
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export type FloorMsg =
  | z.infer<typeof AgentLifecycleSchema>
  | z.infer<typeof AgentIntentSchema>
  | z.infer<typeof AgentDecisionSchema>;

// Re-export so consumers can import everything from one entry.
export { AgentConfigSchema } from './agent.schema';
export type { AgentConfig } from './agent.schema';
