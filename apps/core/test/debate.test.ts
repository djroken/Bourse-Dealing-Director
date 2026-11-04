import { describe, expect, it } from 'vitest';
import { AgentChatMsgSchema } from 'shared';
import { createEngine, type FloorSocket } from '../src/engine';
import { createTalk, parseTalk } from '../src/talk';
import type { Advisor } from '../src/models';
import type { Headline } from '../src/news';

class FakeSocket implements FloorSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  on() {
    return this;
  }
  of(t: string) {
    return this.sent.filter((m) => m.type === t);
  }
}
const NOW = Date.UTC(2026, 10, 4, 22, 0);
const tick = (price: number, change24h: number) => ({ price, change24h, source: 'binance' });
const SYMS = ['BTC-USDT', 'SOL-USDT'];

describe('how a seat says it feels', () => {
  it('reads mood, stance and picks, keeping only known moods and floor symbols', () => {
    expect(parseTalk('{"say":"I like SOL.","mood":"Confident","stance":{"symbol":"sol-usdt","view":"bull","conviction":1.7},"picks":["SOL-USDT","DOGE-USDT","sol-usdt","BTC-USDT"]}', SYMS)).toEqual({
      say: 'I like SOL.', idea: null, mood: 'confident', stance: { symbol: 'SOL-USDT', view: 'BULL', conviction: 1 }, picks: ['SOL-USDT', 'BTC-USDT'],
    });
    expect(parseTalk('{"say":"Meh.","mood":"furious","stance":{"symbol":"DOGE-USDT","view":"BULL"}}', SYMS)).toEqual({ say: 'Meh.', idea: null });
  });
});

function floor(converse: NonNullable<Advisor['converse']>, headlines: Headline[] = []) {
  const prompts: Array<{ model: string; user: string }> = [];
  const advisor: Advisor = {
    handles: (id) => id.startsWith('ollama:'),
    advise: async () => ({ ok: false, reason: 'unused' }),
    status: () => ({ ollama: { host: '', used: 0, cap: 0 }, openrouter: { keySet: false, used: 0, cap: 0 } }),
    converse: async (model, p, t, m) => (prompts.push({ model, user: p.user }), converse(model, p, t, m)),
  };
  const engine = createEngine({ now: () => NOW, cooldownMs: 1e12, advisor });
  const ws = new FakeSocket();
  engine.addClient(ws);
  engine.pushTick('SOL-USDT', tick(215, 4.1));
  engine.pushTick('BTC-USDT', tick(96_000, -0.4));
  ws.sent.length = 0;
  const set = (role: string, model: string) => (engine.agents.find((a) => a.config.role === role)!.config.model = model);
  return { engine, ws, prompts, set, talk: (replies?: number) => createTalk({ engine, now: () => NOW, intervalMs: 0, headlines: () => headlines, ...(replies === undefined ? {} : { replies }) }) };
}

const SOL_NEWS: Headline = { id: 'h1', source: 'CoinDesk', title: 'Solana DEX volume jumps as SOL leads majors', url: null, publishedAt: NOW - 600_000, tag: 'ON-CHAIN', symbols: ['SOL-USDT'] };

describe('a round where the floor talks it out', () => {
  it('Research speaks right after the Director, and its picks reach every later speaker', async () => {
    const { ws, prompts, set, talk } = floor(async () => ({ ok: true, text: '{"say":"Noted.","mood":"calm","stance":null,"idea":null}' }), [SOL_NEWS]);
    set('Quant / Signals', 'ollama:quant');
    await talk().runRound();
    const roles = ws.of('chat').map((m) => m.role);
    expect(roles.slice(0, 2)).toEqual(['Dealing Director', 'Research / News']);
    const research = ws.of('chat')[1]!;
    expect(research).toMatchObject({ stub: true, mood: 'unsure', picks: ['SOL-USDT'] });
    expect(String(research.text)).toContain('Worth a look: SOL-USDT');
    expect(prompts.find((p) => p.model === 'ollama:quant')!.user).toContain("Research's picks this round: SOL-USDT. Say what you make of them.");
    for (const m of ws.of('chat')) expect(AgentChatMsgSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });

  it('seats that disagree answer each other by name, with how they feel now; the close says who is bull and who is bear', async () => {
    const replies: Record<string, string[]> = {
      'ollama:quant': [
        '{"say":"SOL momentum is clean, Kite. I am buying.","mood":"confident","stance":{"symbol":"SOL-USDT","view":"BULL","conviction":0.8},"idea":{"symbol":"SOL-USDT","side":"BUY","confidence":0.8}}',
        '{"say":"Kite, fair on funding, but the trend is the trend. Still long, a bit less sure.","mood":"cautious","stance":{"symbol":"SOL-USDT","view":"BULL","conviction":0.6},"idea":null}',
      ],
      'ollama:mm': [
        '{"say":"Pico, SOL is stretched after 4%. I would fade it.","mood":"sceptical","stance":{"symbol":"SOL-USDT","view":"BEAR","conviction":0.6},"idea":null}',
        '{"say":"Pico, we will see. I stay short-biased.","mood":"sceptical","stance":{"symbol":"SOL-USDT","view":"BEAR","conviction":0.5},"idea":null}',
      ],
    };
    const used: Record<string, number> = {};
    const { ws, prompts, set, talk } = floor(async (model) => {
      const i = (used[model] = (used[model] ?? -1) + 1);
      return { ok: true, text: replies[model]?.[i] ?? '{"say":"Ok.","idea":null}' };
    });
    set('Quant / Signals', 'ollama:quant');
    set('Market Maker', 'ollama:mm');
    await talk().runRound();
    const chat = ws.of('chat');
    const answers = chat.filter((m) => m.replyTo);
    expect(answers.map((m) => [m.name, m.replyTo, m.mood])).toEqual([
      ['Pico Nandra', 'Kite', 'cautious'],
      ['Kite Alvarez', 'Pico', 'sceptical'],
    ]);
    const quantReply = prompts.filter((p) => p.model === 'ollama:quant')[1]!.user;
    expect(quantReply).toContain('- Kite (Market Maker; sceptical, BEAR SOL-USDT 60%): "Pico, SOL is stretched after 4%. I would fade it."');
    expect(quantReply).toMatch(/Your turn: Answer Kite \(Market Maker\), who said: "Pico, SOL is stretched/);
    // Answers come after Risk and before the Director's close.
    const order = chat.map((m) => (m.replyTo ? 'reply' : m.role));
    expect(order.indexOf('Risk Officer')).toBeLessThan(order.indexOf('reply'));
    expect(order.at(-1)).toBe('Dealing Director');
    expect(String(chat.at(-1)!.text)).toMatch(/House view: .*bulls .*Pico \(SOL-USDT\).*bears Kite \(SOL-USDT\)\)\. The floor is split, so size stays small\./);
  });

  it('replies are capped per round and can be turned off', async () => {
    const say = (v: 'BULL' | 'BEAR') => `{"say":"View.","mood":"confident","stance":{"symbol":"SOL-USDT","view":"${v}","conviction":0.7},"idea":null}`;
    const run = async (replies: number) => {
      const { ws, set, talk } = floor(async (model) => ({ ok: true, text: say(model === 'ollama:mm' || model === 'ollama:exec' ? 'BEAR' : 'BULL') }));
      set('Quant / Signals', 'ollama:quant');
      set('Sentiment Desk', 'ollama:sent');
      set('Market Maker', 'ollama:mm');
      set('Execution Trader', 'ollama:exec');
      await talk(replies).runRound();
      return ws.of('chat').filter((m) => m.replyTo).length;
    };
    expect(await run(2)).toBe(2);
    expect(await run(0)).toBe(0);
    expect(await run(4)).toBe(4);
  });

  it('stub seats show a mood and stance from the data, and never answer back', async () => {
    const { ws, talk } = floor(async () => ({ ok: true, text: '{}' }));
    await talk().runRound();
    const chat = ws.of('chat');
    expect(chat.find((m) => m.role === 'Quant / Signals')).toMatchObject({ stub: true, mood: 'confident', stance: { symbol: 'SOL-USDT', view: 'BULL' } });
    expect(chat.find((m) => m.role === 'Risk Officer')).toMatchObject({ mood: expect.stringMatching(/calm|cautious|worried/) });
    expect(chat.some((m) => m.replyTo)).toBe(false);
  });
});
