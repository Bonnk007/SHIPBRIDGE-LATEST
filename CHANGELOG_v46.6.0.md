# ShipBridge v46.6.0 — Review & Hardening

A code review of v46.5.0 that verified the app end-to-end (build, tests, live
endpoints) and fixed a set of correctness, safety, and deployment issues.
All 76 tests pass; production build is clean.

## Correctness

- **Grounding rule was never reaching the model in trace explanations.**
  In `POST /api/cpi-trace/explain`, the anti-hallucination instruction was
  written as an escaped `\${GROUNDING}` inside the step and run prompts, so the
  model received the literal text `${GROUNDING}` instead of the "use ONLY the
  facts, never invent values" rule. This undercut the core "facts are never
  invented" guarantee for the AI trace explanations. Now interpolated correctly.

- **Adapter table builder crashed on non-array `fields`.** `/api/spec-docx`
  returned a 500 (`(a.fields||[]).filter is not a function`) when `fields`
  arrived as an object map rather than an array. Now normalizes array, object,
  and missing/garbage shapes; also guards non-array `adapters` input.

## Data safety

- **Sensitive header names weren't being masked.** `redactHeaders` normalizes
  lookup keys (strips `_ - space`), but the sensitive-key set was stored in raw
  form, so `X-API-Key`, `access_token`, and `access-token` passed through
  unredacted. The set is now normalized the same way. Added `cookie` /
  `set-cookie` / `sessionid` too.

- **OData input sanitization.** `top`, `sinceMinutes`, `messageGuid`, and
  `traceMessageId` are interpolated into CPI OData URLs; they're now clamped to
  bounded integers / stripped to `[A-Za-z0-9-_]` before use.

- **Redirect following disabled on outbound calls.** Live Trigger and CPI trace
  fetches now use `redirect: 'manual'` so an allowlisted host can't 302 a
  bearer-token-bearing request off to an internal address past the allowlist.

## Deployment

- **Optional access gate for public deployments.** Set `APP_PASSWORD` (e.g. on
  Render) and every `/api` route except `/api/health` requires the
  `x-shipbridge-key` header (timing-safe compare). The frontend prompts once and
  stores the key in localStorage. Unset = open, for local dev. Without this the
  public server let anyone burn the Anthropic key and relay requests at CPI
  tenants.

- **In-memory rate limiting.** 30 req/min per IP on AI endpoints, 240/min
  general. Sliding window, self-sweeping, no new dependencies. Not a WAF
  replacement — a floor.

- **Checkpoint waiter leak fixed.** A dropped checkpoint connection cleared its
  timer but never removed the map entry, so dead entries accumulated until the
  50-entry cap permanently rejected new checkpoints until restart. The `close`
  handler now deletes the entry and broadcasts a `closed` event.

- **`npm audit fix`** — cleared the one low-severity body-parser advisory.
  0 vulnerabilities.

## Docs

- CLAUDE.md version (was 36.0.0) and test count (was 59) corrected to match
  reality (46.6.0, 76 tests).
- `.env.example` documents `APP_PASSWORD`.

## New tests

`src/tests/regressions.test.js` pins the header-redaction normalization fix and
the adapter-table input-shape fix so they can't silently regress.

## Not changed (flagged for follow-up)

- `TraceViewer.jsx` is ~75 KB in a single file; worth splitting for
  maintainability.
- `PipelineHero` three.js bundle is large (~870 KB); already lazy-loaded, but a
  candidate for further code-splitting.
- `/api/simulate` is a legacy route name (the Simulator was removed in v38) but
  is still used by HelpPanel; a rename would reduce confusion.
