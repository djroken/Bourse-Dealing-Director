## What and why

## How I tested it
- [ ] `pnpm check`
- [ ] `pnpm --filter web test:e2e` (if UI changed)

## Safety checklist
- [ ] No path to real order placement was added; `LIVE_AVAILABLE` is unchanged
- [ ] No secrets persisted or committed
- [ ] Anything simulated or unbuilt is labelled as such in the UI/docs
