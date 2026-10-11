import { describe, expect, it } from 'vitest';
import { AgentConfigSchema, defaultAgents } from '../src';

describe('default agent roster', () => {
  it('has the eight seats, each valid against the schema', () => {
    expect(defaultAgents).toHaveLength(8);
    for (const a of defaultAgents) expect(() => AgentConfigSchema.parse(a), a.name).not.toThrow();
  });

  it('has unique names and roles', () => {
    expect(new Set(defaultAgents.map((a) => a.name)).size).toBe(defaultAgents.length);
    expect(new Set(defaultAgents.map((a) => a.role)).size).toBe(defaultAgents.length);
  });

  it('has sane risk limits on every seat', () => {
    for (const a of defaultAgents) {
      expect(a.riskLimits.maxClip, a.name).toBeGreaterThan(0);
      expect(a.riskLimits.maxLeverage, a.name).toBeGreaterThan(0);
      expect(a.riskLimits.dailyLossStop, a.name).toBeGreaterThan(0);
    }
  });

  it('rejects a seat with a non-positive limit or an unknown autonomy', () => {
    const ok = defaultAgents[0]!;
    expect(AgentConfigSchema.safeParse({ ...ok, riskLimits: { ...ok.riskLimits, maxClip: 0 } }).success).toBe(false);
    expect(AgentConfigSchema.safeParse({ ...ok, autonomy: 'YOLO' }).success).toBe(false);
  });
});
