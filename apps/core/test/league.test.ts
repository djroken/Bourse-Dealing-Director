import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLeague, leagueKey, tally } from '../src/league';
import type { IdeaRecord } from '../src/scorecard';

const idea = (id: string, model: string, ret: number | null, over: Partial<IdeaRecord> = {}): IdeaRecord => ({
  id, ts: 1_000 + Number(id.replace(/\D/g, '') || 0), agentId: 'TKT-004', role: 'Quant / Signals', name: 'Pico', model, temperature: 0.3, autonomy: 'SUGGEST',
  symbol: 'BTC-USDT', side: 'BUY', size: 1, confidence: 0.6, rationale: 'r', price: 100, change24h: 1, source: 'binance', filled: false,
  outcome: ret === null ? null : { horizonMs: 900_000, exitPrice: 100 + ret, returnPct: ret, correct: ret > 0 }, ...over,
});

describe('model league', () => {
  it('pools stub labels into one baseline, groups real models, ranks by average return', () => {
    expect(leagueKey('gpt-5.1')).toBe('stub rule');
    expect(leagueKey('ollama:llama3.2')).toBe('ollama:llama3.2');
    expect(leagueKey('external agent (MCP)')).toBe('guest agents (MCP)');
    const rows = tally([
      idea('1', 'gpt-5.1', -0.2), idea('2', 'claude-opus-4.5', 0.1),
      idea('3', 'openrouter-free:deepseek/deepseek-chat:free', 0.5), idea('4', 'openrouter-free:deepseek/deepseek-chat:free', -0.1, { role: 'Sentiment Desk' }),
    ] as never);
    expect(rows.map((r) => [r.model, r.ideas, r.hits])).toEqual([['openrouter-free:deepseek/deepseek-chat:free', 2, 1], ['stub rule', 2, 1]]);
    expect(rows[0]).toMatchObject({ hitRate: 0.5, avgReturnPct: 0.2, seats: ['Quant / Signals', 'Sentiment Desk'] });
  });
  it('an idea the stub rule made after a model failed is credited to the baseline, not the model (flag or older rationale)', () => {
    const rows = tally([
      idea('1', 'ollama:qwen3', 0.4),
      idea('2', 'ollama:qwen3', -0.9, { fallback: true }),
      idea('3', 'ollama:qwen3', -0.9, { rationale: 'ollama:qwen3 unavailable (timed out); stub momentum rule instead' }),
    ] as never);
    expect(rows.map((r) => [r.model, r.ideas])).toEqual([['ollama:qwen3', 1], ['stub rule', 2]]);
  });
  it('reads every session from the idea log, adds this session\'s newer ideas once, skips junk and unscored or expired ideas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bourse-league-'));
    const file = join(dir, 'ideas.jsonl');
    writeFileSync(file, [JSON.stringify(idea('1', 'ollama:qwen3', 1)), 'not json', JSON.stringify({ hello: 1 }), '', JSON.stringify(idea('2', 'ollama:qwen3', -0.5))].join('\n') + '\n');
    let t = 0;
    const session = [idea('2', 'ollama:qwen3', -0.5), idea('3', 'ollama:qwen3', 0.2), idea('4', 'ollama:qwen3', null), idea('5', 'ollama:qwen3', 9, { expired: true })];
    const league = createLeague({ file, session: () => session, now: () => t });
    const l = await league.get();
    expect(l).toMatchObject({ scored: 3, skipped: 2, source: 'log+session' });
    expect(l.rows).toEqual([expect.objectContaining({ model: 'ollama:qwen3', ideas: 3, hits: 2 })]);
    expect(l.rows[0]!.avgReturnPct).toBeCloseTo(0.7 / 3);
    session.push(idea('6', 'ollama:qwen3', 1));
    expect((await league.get()).scored).toBe(3); // cached
    t += 31_000;
    expect((await league.get()).scored).toBe(4);
    expect((await createLeague({ file: null, session: () => session }).get()).source).toBe('session');
  });
});
