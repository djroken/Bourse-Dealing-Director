# Security Policy

Hermes is an **early prototype**. It paper-trades only, cannot place real orders, and has no authentication on its local `core` service (it binds to loopback by default). Please read the README's Safety section before running it anywhere other than your own machine.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:

**Security tab → "Report a vulnerability"** on this repository.

Include what you found, how to reproduce it, and the impact you expect. This is a solo project, so please be patient; I'll acknowledge reports as soon as I can.

## In scope

- Anything that lets a web page or remote host drive `core` despite the Origin policy or loopback default
- Secrets (API keys typed into Setup) being persisted, logged or returned by the web app or core
- Weaknesses in the secret store's encryption
- Any path that could route a real order while Live mode is unavailable

- The MCP endpoint (`/mcp`): auth bypass, a way past the paper-only limits or risk gate, or anything that lets a guest agent reach a venue

## Known limitations (not vulnerabilities)

- `core` has no user accounts; do not expose it to a network. The one exception is `/mcp`, which needs a bearer token (`HERMES_MCP_TOKEN`); it is off unless you set one, and it only reaches paper books.
- Keys entered in Setup are held in browser memory and never written to `localStorage`. Core can store them encrypted (AES-256-GCM, master key from `HERMES_MASTER_KEY`), but it has no login, so anyone who can reach it on your machine can overwrite or delete stored keys (never read them). The encrypted file protects against someone copying the disk, not against malware running as you.
- Agents are stub rules unless you point a seat at a model (`ollama:`, `openrouter:`, `openrouter-free:`). Model seats are suggest-only and core sizes every order, but a model sees the seat's mandate, the symbol and its price; with OpenRouter that goes to a third party. `openrouter:` can cost money (use `openrouter-free:` to refuse paid models). There is no exchange integration.
