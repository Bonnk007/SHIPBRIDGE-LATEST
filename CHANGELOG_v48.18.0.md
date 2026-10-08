# v48.18.0 — Intelligence: content viewer + header buttons

Two contained fixes for Dependency Intelligence. No engine changes,
no layout restructure — same `dependencies.js`, all 197 tests pass.

---

## Problem 1 — Add iFlow + Clear All buttons

**Files:** `App.jsx`, `Intelligence.jsx`

The Intelligence header now shows two buttons when flows are loaded:

- **Add iFlow** — secondary button, accepts multiple ZIPs. Reuses the
  existing `onUpload` / `handleFiles` handler — same code path as the
  shell bar's hidden file input. Visible only when `flows.length > 0`
  (the empty state already has its own upload prompt).

- **Clear all** — ghost button, calls the existing `clearAll()` in
  App.jsx via a new `onClear` prop. Gated behind a browser `confirm()`
  dialog so you don't accidentally nuke your session.

## Problem 2 — Content viewer for every asset kind

**Files:** `parser.js`, `App.jsx`, `Intelligence.jsx`

Previously the content viewer only resolved Groovy scripts (via
`step.config.preview`) and XSLTs (via `step.config.xsltContent`).
Every other kind — mappings, value mappings, schemas, ProcessDirect,
certificates, endpoints — returned `null` and rendered blank.

### What changed

**parser.js — carry parsed data through:**

- `flow.mappings` — runs `parseMmap()` (from `packageParser.js`) on
  every `.mmap` file in the ZIP and stores the result on the flow.
  Previously this XML was read for schema-ref extraction then discarded.

- `flow.scriptContents` — the full `{ filename: sourceCode }` dict
  from the ZIP. Previously only available as a local variable inside
  `parseZip()`, used for step matching but never persisted on the flow.

- `flow.xsltContents` — same treatment for XSLT files.

**App.jsx — package path parity:**

Sub-processes loaded from package ZIPs now also receive `mappings`,
`valueMappings`, `scriptContents`, and `xsltContents` from the
already-parsed `pkg` object.

**Intelligence.jsx — content renderer per kind:**

The `resourceContent` useMemo now returns typed objects:

| Kind           | Type          | What it shows                                                |
| -------------- | ------------- | ------------------------------------------------------------ |
| `script`       | `code`        | Groovy source — step ref first, then `scriptContents` fallback |
| `xslt`         | `code`        | XSLT source — step ref first, then `xsltContents` fallback   |
| `mapping`      | `mapping`     | Two-column table: source → target, with UDF function calls    |
| `valueMapping` | `valueMapping`| Grouped agency view with source/target entry pairs            |
| `schema`       | `schema`      | Which mappings/adapters reference it                          |
| `processDirect`| `explanatory` | "Routing label, no body — see impact panel"                   |
| `certificate`  | `explanatory` | "Alias reference — material lives in tenant keystore"         |
| `endpoint`     | `explanatory` | "Adapter configuration — connection params"                   |

Four new sub-components handle the rendering: `MappingContent`,
`ValueMappingContent`, `SchemaContent`, `ExplanatoryContent`.

### Script fallback fix

A script bundled in the ZIP but not referenced by any step used to
show blank. The content resolver now falls back to
`flow.scriptContents[name]` before giving up. Same for XSLTs via
`flow.xsltContents[name]`.

---

## What we did NOT change

- `dependencies.js` — zero changes. Same engine, same index, same
  impact/dead-asset/cycle detection.
- `flowSet.js`, `iflowCompare.js`, `packageCompare.js` — untouched.
- All other tools (Trace, Trigger, Compare, Converter, Docs) — untouched.
- All 197 existing tests pass without modification.
