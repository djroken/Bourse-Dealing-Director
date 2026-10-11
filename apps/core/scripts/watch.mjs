#!/usr/bin/env node
// Prints the floor stream from a running core. Usage: pnpm watch:core  (CORE_URL overrides ws://127.0.0.1:4000/agents)
import WebSocket from 'ws';

const url = process.env.CORE_URL ?? 'ws://127.0.0.1:4000/agents';
const ws = new WebSocket(url);

ws.on('open', () => console.error(`connected to ${url} (Ctrl-C to quit)`));
ws.on('message', (data) => {
  try {
    const m = JSON.parse(String(data));
    const t = new Date(m.ts ?? Date.now()).toISOString().slice(11, 19);
    const detail = m.type === 'lifecycle' ? m.status : `${m.side ?? m.action} ${m.symbol} ${m.size}${m.price ? ` @ ${m.price}` : ''} ${m.rationale ?? ''}`;
    console.log(`${t}  ${String(m.type).padEnd(9)} ${m.agentId}  ${detail}`);
  } catch {
    console.log(String(data));
  }
});
ws.on('error', (e) => {
  console.error(`could not connect to ${url}: ${e.message}. Is core running? (pnpm dev:core)`);
  process.exitCode = 1;
});
ws.on('close', () => process.exit(process.exitCode ?? 0));
