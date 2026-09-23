# v48.19.0 — Intelligence restructure: two-column workbench

Layout restructure of Dependency Intelligence from a vertically stacked
dashboard into a two-column workbench. No engine changes — same
`dependencies.js`, all 197 tests pass.

---

## What changed

The single-column Intelligence component (335→659 lines in v48.18.0)
is now four focused components:

| File | Lines | Role |
|------|-------|------|
| `Intelligence.jsx` | 148 | Layout shell, state, index computation |
| `IntelligenceLeft.jsx` | 218 | Left panel: landscape strip, flows, asset browser |
| `IntelligenceDetail.jsx` | 348 | Right column: selected asset detail + content viewer |
| `IntelligenceOverview.jsx` | 120 | Right column: landscape overview when nothing selected |

## Layout

**Left column (300px, fixed, scrollable):**

- **Landscape strip** — 3 numbers only: flows loaded, dead assets, cycles.
  The old 7-stat tile grid is gone. You see the health check at a glance
  without it dominating the screen.

- **Flows list** — compact, clickable. Click a flow to filter the asset
  browser to just that flow's assets. Click again (or "All flows") to
  unfilter. Double-click to rename (same session-only rename from
  v48.17.0, just inline now). Add iFlow + Clear all buttons live in the
  header here.

- **Asset browser** — searchable list of every script / mapping / XSLT /
  schema / value-mapping / ProcessDirect / certificate / endpoint across
  all loaded flows. Each row shows: kind badge (GS, MM, XS, VM, PD,
  etc.), asset name, and shared/dead badges when applicable. Click to
  select → opens detail on the right.

**Right column (fills remaining width):**

- **Nothing selected → landscape overview:** shared resources, dead
  assets, circular dependencies, risks & complexity. Clicking any
  shared or dead item in the overview selects it and switches to detail.

- **Asset selected → full detail view:** everything about one asset in
  one place:
  - Header: kind badge, shared/dead status, name, owning flows
  - Content viewer (from v48.18.0): code, mapping table, value mapping
    entries, schema references, or explanatory text
  - Directly used by (flow chips)
  - Transitively impacted via ProcessDirect
  - Status summary with actionable text (safe to remove / coordinate
    changes across N flows)

## What we did NOT change

- `dependencies.js` — zero changes.
- `parser.js` — zero changes (v48.18.0 additions are carried forward).
- `App.jsx` — zero changes beyond what v48.18.0 added.
- All other tools — untouched.
- All 197 existing tests pass without modification.

## Migration from v48.18.0

Drop-in replacement. The `Intelligence` component accepts the same
props (`registry`, `onUpload`, `onRename`, `onClear`). The three new
sub-components are internal — they're imported only by `Intelligence.jsx`.
