# Hermes Trading Floor

A plug‑and‑play AI‑agent trading desk that can run standalone or be driven by external agents via Hermes's MCP server and REST API.

## Stack
- **Monorepo** (pnpm workspaces)
  - `apps/web`: Next.js 15 + React + TypeScript (UI)
  - `apps/core`: Node 20 + TypeScript + Fastify (market data, agent engine, MCP server)
  - `packages/shared`: Shared TypeScript schemas and utilities
- **Data**: SQLite via Drizzle (local), Postgres optional; Redis optional for pub/sub.
- **Real‑time**: WebSocket for market data and floor events.
- **Theming**: IBM Plex Sans + IBM Plex Mono; dark, light, system, glass themes.

## Quick Start

1. **Install dependencies**
   ```bash
   pnpm install
   ```

2. **Start the stack**
   ```bash
   pnpm dev
   ```
   This runs:
   - `apps/web` (Next.js dev server on http://localhost:3000)
   - `apps/core` (Fastify server on http://localhost:4000)
   - `packages/shared` (watch build)

3. **Environment**
   Copy `.env.example` to `.env` and fill in API keys for market data feeds and any LLM providers you wish to use.

## Project Structure
```
hermes-trading-floor/
├─ apps/
│  ├─ web/          # Next.js UI
│  └─ core/         # Fastify backend
├─ packages/
│  └─ shared/       # TypeScript schemas, agent seed
├─ .hermes/
│  └─ plans/        # Implementation plan
└─ ...
```

## Next Steps
See `.hermes/plans/plan.md` for detailed milestones and implementation plan.

## License
MIT
