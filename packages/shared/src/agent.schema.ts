import { z } from 'zod';

export const AgentConfigSchema = z.object({
  name: z.string(),
  role: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2),
  autonomy: z.enum(['SUGGEST', 'APPROVE', 'AUTO']),
  /** Whether this seat originates trade ideas. Seats that only coordinate, research or police risk never do. */
  trades: z.boolean(),
  mandate: z.string(),
  riskLimits: z.object({
    /** Largest single order, in USD notional. */
    maxClip: z.number().positive(),
    maxLeverage: z.number().positive(),
    /** Stop deciding once the day's P&L is down this many USD. */
    dailyLossStop: z.number().positive()
  }),
  tools: z.array(z.string()),
  feeds: z.array(z.string())
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
