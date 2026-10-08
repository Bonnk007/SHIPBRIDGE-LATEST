# v48.23.0 — Checkpoint removed, redaction consolidated, docs refreshed

**Focus:** housekeeping. No user-visible feature changes; smaller surface area, cleaner boundaries, honest docs.

## Removed

- **Checkpoint feature.** The runtime-message-interception capability (server routes at `/api/checkpoint*`, the `Checkpoint.jsx` component, and every reference across App.jsx, Sidebar, Home tile, HelpPanel and the render tests) has been deleted. Rationale: it contradicted ShipBridge's read-only positioning, didn't play well with `APP_PASSWORD` (the generated Groovy could not carry the app key, and `EventSource` can't attach the header), and never made it into the demo walkthrough. `server/index.js` shrunk from 1329 → 1246 lines as a result.

## Consolidated

- **`src/lib/redact.js` merged into `src/lib/redaction.js`.** Two files with adjacent concerns is drift-in-waiting. Now one file, two clearly labelled sections:
  - Text/regex payload redaction (existing `redactPayload`, `REDACTION_CATEGORIES`) used by TraceViewer and debug-report export.
  - Structural/key-based redaction (`isSensitiveKey`, `redact`, `redactHeaders`) used by object export flows.
  Both jobs still exist and are still tested.

## Refreshed

- **`CLAUDE.md`** version updated 46.6.0 → 48.23.0, test baseline updated 76 → 208.
- **`PROJECT_CONTEXT.md`** version updated v36 → v48.23.0 with a one-line "what's actually in this release" note.

## What I chose NOT to do this release

- **Reset button in Compare** — already present at CompareView.jsx L142 (`✕ Reset` in header) and L255 (`↺ Reset` in summary bar). No change needed.
- **Step-name resolution in Real Trace** — non-trivial to fix blind. The matching code exists (`stepLabel` at L1434, flow-name normalization at L76) but silently fails when the ZIP name doesn't match runtime's `iflwName`. Needs a real failing trace to test against.

## Tests

208 passing, 1 skipped (unchanged from v48.22.0). Zero engine changes.
