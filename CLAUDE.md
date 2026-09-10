# ShipBridge — Claude Code Instructions

## What you're working on

ShipBridge is a SAP CPI developer toolkit. React + Vite frontend, Express backend. 5 modules: Real Trace, Live Trigger, Documentation Spec Builder, Intelligence, Converter.

Full project context is in **`PROJECT_CONTEXT.md`** — read that file first before doing anything.

## Quick facts

- **Version:** 46.6.0
- **Deployed:** live on Render
- **Deadline:** July 24, 2026 (4-week plan from June 29)
- **Test baseline:** 76 tests passing
- **Working folder name:** `triggerflow_fixed` (legacy — do not rename)

## How to work here

1. Always run `npx vitest run` before big changes to establish baseline.
2. Small commits > large ones.
3. Ask before scope expansion.
4. User prefers short direct messages, dislikes long preambles.
5. Follow the 11 locked design decisions in PROJECT_CONTEXT.md.

## Current blockers

- **Real Trace** is fully built but blocked on a BTP config issue (user's action needed — new service key on `api` plan with `MonitoringRead` role). Do not try to fix this in code.

## What's next

See PROJECT_CONTEXT.md → "Not started" section for the priority list.
