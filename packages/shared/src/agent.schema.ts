import { z } from 'zod';

export const AgentConfigSchema = z.object({
  name: z.string(),
  role: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2),
  autonomy: z.enum(['SUGGEST', 'APPROVE', 'AUTO']),
  mandate: z.string(),
  riskLimits: z.object({
    maxClip: z.number().positive(),
    maxLeverage: z.number().positive(),
    dailyLossStop: z.number().positive()
  }),
  tools: z.array(z.string()),
  feeds: z.array(z.string())
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
