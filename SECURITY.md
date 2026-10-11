# Security Policy

Hermes is an **early prototype**. It paper-trades only, cannot place real orders, and has no authentication on its local `core` service (it binds to loopback by default). Please read the README's Safety section before running it anywhere other than your own machine.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:

**Security tab → "Report a vulnerability"** on this repository.

Include what you found, how to reproduce it, and the impact you expect. This is a solo project, so please be patient; I'll acknowledge reports as soon as I can.

## In scope

- Anything that lets a web page or remote host drive `core` despite the Origin policy or loopback default
- Secrets (API keys typed into Setup) being persisted or leaked by the web app
- Any path that could route a real order while Live mode is unavailable

## Known limitations (not vulnerabilities)

- `core` has no authentication; do not expose it to a network.
- There is no server-side key store yet. Keys entered in Setup are held in browser memory for the tab only and are never written to `localStorage`.
- Agents are scripted; there is no model or exchange integration.
