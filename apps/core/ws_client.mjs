import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:4000');
ws.on('open', () => console.log('[client] connected'));
ws.on('message', (data) => console.log('[client] RECEIVED:', data.toString()));
ws.on('error', (e) => { console.log('[client] error:', e.message); });
setTimeout(() => { ws.close(); console.log('[client] done'); process.exit(0); }, 7000);
