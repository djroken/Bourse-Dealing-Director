import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Engine, FloorAgent } from './engine';
import { TRADED_SYMBOLS } from './engine';

/**
 * MCP server: lets an outside agent (Claude, OpenAI, OpenClaw, any MCP client) trade the paper book on live prices.
 *
 * What a guest can and cannot do is decided here and in the engine, not by the agent:
 *  - Paper funds only. There is no route from this module to a venue, and Live mode does not exist.
 *  - Each guest gets its own $100k paper book and fixed risk limits it cannot change.
 *  - Orders go through the same risk gate as everything else and are rejected, never clamped.
 *  - Everything the guest sends is untrusted: sizes and symbols are validated, chat text is cleaned and rate-limited.
 */

export const MCP_AGENT_HEADER = 'x-bourse-agent';

/** Constant-time bearer check. An unset or short token disables MCP entirely. */
export function tokenOk(expected: string | undefined, header: string | undefined): boolean {
  if (!expected || expected.length < 16 || !header) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const fail = (reason: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason }) }], isError: true });

export function createMcpServer(engine: Engine, guest: FloorAgent): McpServer {
  const server = new McpServer({ name: 'bourse-trading-floor', version: '0.1.0' });
  const Symbol_ = z.enum(TRADED_SYMBOLS as [string, ...string[]]);

  server.registerTool(
    'get_quotes',
    { description: 'Latest prices and 24h change for BTC-USDT, ETH-USDT and SOL-USDT, from the live feed core polls.', inputSchema: {} },
    async () => json({ quotes: engine.quotes(), note: 'Live prices. Orders fill on a paper book at the latest price; no real money moves.' }),
  );

  server.registerTool(
    'get_positions',
    { description: 'Your own paper positions and P&L, marked to the latest prices.', inputSchema: {} },
    async () => json(engine.positionsOf(guest)),
  );

  server.registerTool(
    'get_risk',
    { description: 'Your risk limits (max order in USD, leverage, daily loss stop), how much of each you have used, and whether the floor is halted.', inputSchema: {} },
    async () => json(engine.riskOf(guest)),
  );

  server.registerTool(
    'place_order',
    {
      description:
        'Place a paper market order at the latest live price. Size is in asset units (e.g. 0.01 BTC). Core rejects, and does not resize, any order over your max order size, over your exposure limit, after your daily loss stop, or while the floor is halted.',
      inputSchema: {
        symbol: Symbol_.describe('BTC-USDT, ETH-USDT or SOL-USDT'),
        side: z.enum(['BUY', 'SELL']),
        size: z.number().positive().finite().describe('Asset units, e.g. 0.01'),
      },
    },
    async ({ symbol, side, size }) => {
      const r = engine.submitOrder(guest, symbol, side, size, `Placed by ${guest.config.name}`);
      return r.ok ? json({ ...r, paper: true }) : fail(r.reason);
    },
  );

  server.registerTool(
    'read_floor',
    { description: 'The most recent floor events (agent ideas, fills, vetoes, chat). Read-only.', inputSchema: { limit: z.number().int().min(1).max(60).default(20) } },
    async ({ limit }) => json({ events: engine.recentFloor(limit) }),
  );

  server.registerTool(
    'post_to_floor',
    { description: 'Say something on the floor chat (max 400 characters, plain text, 5 messages per 10 seconds). Humans watching the desk see it.', inputSchema: { text: z.string().min(1).max(400) } },
    async ({ text }) => {
      const r = engine.post(guest, text);
      return r.ok ? json({ ok: true }) : fail(r.reason);
    },
  );

  return server;
}
