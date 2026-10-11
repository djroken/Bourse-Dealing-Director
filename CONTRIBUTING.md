# Contributing

Thanks for looking. Hermes is an early prototype and a solo project, so small, focused PRs are easiest to review.

## Setup

Node 22.13+ and pnpm 11 (`corepack enable` picks the right one).

```sh
pnpm install
pnpm dev        # web on :3000, core on :4000
```

## Before you open a PR

```sh
pnpm check      # typecheck + lint + unit tests across all packages
```

For UI changes also run the end-to-end suite (hermetic, no network):

```sh
pnpm build
pnpm --filter web exec playwright install chromium   # first time only
pnpm --filter web test:e2e
```

## Ground rules

- **Safety first.** Live trading is deliberately unavailable (`LIVE_AVAILABLE` in `apps/web/lib/desk/data.ts`). Do not flip it, or add any path that routes a real order, without a discussion issue first. A test fails if it is flipped.
- **Be honest in the UI.** Anything simulated or unbuilt must say so.
- **Never persist secrets** in `localStorage` or commit them. `.env` files are git-ignored.
- Add or update tests with behaviour changes. Keep PRs to one concern.
- `apps/web` uses Next.js 16, which differs from older versions; see `apps/web/AGENTS.md`.

## Commit style

Short imperative subject ("Fix funding scale for Hyperliquid"), with a body explaining why when it isn't obvious.
