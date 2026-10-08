# v48.28.0 — security, correctness and test coverage

Fixes from a full code review of v48.27.0. No features added, no behaviour
changed except where the old behaviour was wrong. Test baseline 229 → 309.

## Security (matters because this is deployed)

- **The server now refuses to start in production without `APP_PASSWORD`.**
  Unset, every `/api` route was public — including `/api/simulate`, which takes
  a caller-supplied `system` prompt and relays it to the Anthropic API on this
  server's key. That is a general-purpose LLM proxy billed to whoever deployed
  it. `server/index.js`
- **The OAuth token cache no longer lets one user borrow another's CPI session.**
  The key was `tokenUrl::clientId` with the secret left out, and the cache is
  process-wide. A caller who knew only those two non-secret values (both of
  which the frontend keeps in localStorage) got a cache hit populated by someone
  else's real credentials and a valid bearer token for their tenant, without
  ever authenticating. The secret is now hashed into the key. `server/cpiTrace.js`
- **Rate limiting is no longer bypassable.** The limiter read the client IP
  straight from `X-Forwarded-For` with no `trust proxy`, so a different header
  per request meant a fresh bucket per request. Now `app.set('trust proxy', 1)`
  plus `req.ip`. `server/index.js`
- **`/api/compare-summary` is in `AI_ROUTES`.** Added after the list was written,
  it was paying the 240/min general budget instead of the 30/min AI one, and it
  skipped the API-key check every sibling endpoint performs. `server/index.js`
- **`getToken` no longer follows redirects while carrying `client_secret`.**
  `cpiGet` had `redirect: 'manual'` with a comment explaining exactly why; the
  token POST, whose body holds the secret, did not. `server/cpiTrace.js`
- **Uploaded `.docx` templates are checked for decompressed size** before any
  part is read, via a new `loadDocxZip`. A few-KB zip bomb previously expanded
  into the Node heap unbounded. `server/specDocx.js`, `server/specMultiFlow.js`
- **CRLF is rejected in forwarded header *values*,** not just keys. `server/index.js`
- **Loopback is only allowlisted outside production,** where it made Live Trigger
  a port scanner for the rest of the container. `server/urlAllowlist.js`

## Redaction — Share-safe now covers what the README promised

- **Headers, exchange properties and error text are redacted.** Payload text was
  scrubbed before leaving the browser; the step object was not, and the server
  forwards `step.Headers` and `step.ExchangeProperties` to the Anthropic API
  verbatim — which is where `Authorization` values, `SAP_` credential aliases,
  tenant URLs and client IDs actually live. `redact()`/`redactHeaders()` existed
  for this and were called from nowhere but a test. New `redactTraceStep()` is
  wired into both the explain call and the Markdown export, which previously
  stamped "_Redacted for sharing_" above unredacted CPI error strings.
- **`hostnames` is hostname redaction, not a two-domain allowlist.** It masked
  only `*.hana.ondemand.com` and `*.sap.com`, letting through `*.cloud.sap`
  (S/4HANA Cloud), SuccessFactors, Ariba, every customer-owned domain, `Host:`
  headers and bare IPs. Loopback and the URL path are deliberately kept.
- **Auth headers are caught in every real shape.** The pattern required the
  scheme immediately after the separator, so `"Authorization": "Bearer …"` — how
  a captured CPI header is actually serialised — did not match. Also now caught:
  `Proxy-Authorization`, `Token`/schemeless values, XML `<password>` elements,
  YAML and properties lines, and `clientSecret`.
- **`isSensitiveKey` matches families, not an exact list.** `Proxy-Authorization`,
  `X-Auth-Token`, `refresh_token`, `pwd`, `passphrase`, `apiSecret` and
  `x-csrf-token` all passed before. `author` and `authority` still don't match.

## Correctness — cases where the tool reported something false

- **`getProps` reads a step's own properties, not its whole subtree.** It used
  `querySelectorAll('*')`, so because `subProcess` is in `STEP_TAGS`, the
  exception subprocess every production iFlow has absorbed the properties of
  every step inside it, last-wins. A subprocess containing a Groovy step came
  out as `kind: 'GroovyScript'` with a bogus `scriptRef`. Also removes an O(n²).
- **`normalizePDAddress('pd:/X')` returned `'pd:/X'` unchanged** — it rebuilt its
  input where it meant to produce `pd://`. Combined with `specProcessDirect`
  stripping only `pd://`, a perfectly resolvable ProcessDirect call rendered as
  "not in package".
- **One shared ProcessDirect normalizer.** `flowSet.js` lowercased and stripped
  slashes, `dependencies.js` only trimmed. A pair differing in case linked in the
  Spec Builder and not in impact analysis — the one feature whose entire value is
  being right about what breaks. Both now use `pdKey()`; `brokenPD` still reports
  the readable address, not the match key.
- **A Content Modifier table no longer vanishes on a raw `<` or `&`.**
  `parseCMTable` wrapped the value in a synthetic root, and any un-wrappable
  value fell through to a no-op unescape and returned `[]` — silently erasing
  every header and property for that step from the spec, with only `config._debug`
  recording the zero. Now escalates: strict parse → escape bare ampersands →
  textual recovery, with a warning.
- **An adapter type is never the message flow's name.** The fallback chain ended
  `|| mfName || 'HTTP'`, so a ProcessDirect flow with no `ComponentType` was
  classified as a plain endpoint and the chain broke silently.
- **The LCS diff has a size guard (`DIFF_LINE_LIMIT`).** `packageCompare` calls it
  on raw EDMX/XSD, where 20k lines is ordinary; the unguarded `(m+1)×(n+1)`
  matrix asked for ~4×10⁸ slots and killed the tab. Reports "too large to diff"
  instead of crashing.
- **`diffConfig` excludes `rawProps`, `messageFlowId`, `preview`, `_debug`.** One
  address change was reported twice, and `messageFlowId` — which CPI regenerates
  on copy or re-save — produced a confident "adapter changed" on an identical
  adapter.
- **Exception handlers are detected structurally.** `CATEGORY_KINDS` listed kinds
  `resolveKind` never emits (`JsScript`, `ExclusiveGateway`, `ContentEnricher`,
  `ExceptionSubProcess`), leaving a name regex that missed "Fault Handler" and
  double-counted a Content Modifier called "Set Error Message".
- **`matchSteps` tracks matches by map key, not `step.id`.** The parser does set
  `id`, so production was fine, but any step object without it was reported as
  both matched and removed.
- **`Object.hasOwn` instead of `in`** across `packageCompare`: an artifact named
  `constructor` or `toString` was reported as changed with a function as its
  before-value.
- **A multi-artifact package no longer silently loses flows.** `packageParser`
  kept the *last* `.iflw` while `parseZip` kept the *first*; both now take the
  first and say how many they found. Same-basename files in different folders no
  longer overwrite each other, text entries are size-capped, and the loose
  value-mapping match is on the filename so a `valuemapping/` folder no longer
  drags its whole contents into memory as strings.
- **Value-mapping CSV warns instead of losing data** — columns beyond the first
  two, and an unterminated quote that swallowed the rest of the file.

## UI

- **`.docx` template upload works.** `btoa(String.fromCharCode(...new Uint8Array(buf)))`
  passes one argument per byte and threw `RangeError: Maximum call stack size
  exceeded` on any file past roughly 100KB — i.e. every real client template, the
  headline "Bring your own template" feature. Now a shared `fileToBase64`.
- **The AI no longer explains the wrong thing.** The clear-on-change effect
  depended on `[sel]` alone, so opening a second trace left the first trace's
  explanation above step 0. Auto-explain also fired before the payload had loaded
  and read `undefined` from a stale closure, and its key collided across sibling
  steps so only the first failed step in a run ever fired.
- **The CPI Assistant is no longer a dead bubble on any error.** `HelpPanel` was a
  hand-rolled copy of `streamAI` that forgot `resp.ok`, so a 401 or 500 left a
  loading dot forever and `catch {}` swallowed mid-stream errors. It now uses
  `streamAI` and has a Stop button.
- **Drag-resize can't wedge the page.** Listeners attached in the handler with no
  cleanup meant a mouseup lost outside the viewport left `userSelect: none` and
  the resize cursor stuck page-wide. Now an effect, plus arrow-key resizing and a
  debounced localStorage write instead of ~60/second.
- **Live Trigger requests can be cancelled** — a 300-second timeout with no Stop
  previously left reloading as the only exit.
- **Payload loading is pooled to 5 and aborted on trace change** — a 60-step
  trace fired 60 concurrent credentialed POSTs whose late responses wrote into
  the state of a trace the user had left.
- **`CompareView` no longer calls `setError` during render,** and no longer leaves
  a stale banner over a valid diff. A failed package parse now reports its real
  reason rather than `parseZip`'s misleading "No .iflw file found".
- **Keyboard access**: trace steps and the message list are reachable and
  arrow-navigable; Escape closes the help panel.
- `Documentation` surfaces a failed template load instead of showing an empty
  form; its ProcessDirect memo actually caches (it re-resolved across every flow
  on each keystroke); blob URLs are revoked on a delay so downloads work in
  Firefox and Safari; `main.jsx` no longer drops a `Headers` instance.

## Dependencies

- Removed `framer-motion` (one entrance fade, replaced with the `lp-fade`
  keyframe already in the file plus an IntersectionObserver) and `lenis` (never
  imported anywhere). Bundle: **798KB → 674KB raw, 238KB → 196KB gzip.**
- `three` and `@react-three/fiber` are **kept**: nothing imports
  `src/components/landing/PipelineHero.jsx`, so they ship no bytes, but deleting
  them would break that component. Wire the hero up or delete both — your call.

## Tests

229 → 309. Four new files, covering what had none:

- `parser.test.js` — a realistic multi-process `.iflw` fixture with an exception
  subprocess, Content Modifier tables with raw `<` and `&`, ProcessDirect
  normalisation, adapter-type resolution. No test imported `parser.js` before.
- `redactionBypass.test.js` — negative tests. Every previous redaction test
  asserted a positive match, so none of the bypasses above would have failed the
  suite. Includes must-not-over-mask cases.
- `diffGuards.test.js` — LCS size guard, noise-field exclusions, and the
  ProcessDirect normalizer agreeing across modules.
- `fileToBase64.test.js` — asserts the old `btoa` approach throws at 2MB and the
  replacement doesn't.

## Still open (deliberately not done here)

The pure functions still trapped in view files — `layOutFlow`, `computeLineDiff`,
`computeRunChanges`, `exportReport` in `TraceViewer.jsx`; `prettyXML`,
`xmlToJSON`, `jsonToXSD` in `Converter.jsx`. Nothing can import them, which is
why `converterXsd.test.js` re-implements them and its comment about catching
drift cannot be true. Moving them to `src/lib/` and pointing that test at the
real code is the highest-value remaining change, and it is an architectural call.
