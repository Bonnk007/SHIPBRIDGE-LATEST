# ShipBridge — Project Context

**For any AI assistant (Claude Code, Claude.ai, ChatGPT) continuing work on this project.**

Read this file first. It contains everything needed to pick up where the previous session left off — architecture, state, locked decisions, and what's pending.

---

## What ShipBridge is

A web-based **SAP CPI developer toolkit**. Aimed at CPI consultants (built for a friend who works as one) to help debug, document, and understand SAP Cloud Platform Integration flows.

**5 modules:**
1. **Real Trace** (HEADLINE) — reads real Message Processing Log + trace data from a deployed CPI tenant. The "CPI black-box flight recorder."
2. **Live Trigger** — fires payloads at deployed CPI endpoints (OAuth2 or Basic Auth).
3. **Documentation / Spec Builder** — generates client-format Technical Specification `.docx` documents from iFlows.
4. **Intelligence** — cross-flow dependency analysis (shared scripts, ProcessDirect links, dead assets, cycles).
5. **Converter** — XML/JSON/CSV/YAML/XSLT/Markdown converter.
6. **Simulator** — REMOVED in v38. Real Trace replaced it; it read predicted state, Real Trace reads what CPI actually recorded.

**Current version:** v36 (as of end of last session).
**Live deployment:** hosted on Render (URL: user's own `shipbridge.onrender.com` variant).

---

## Stack

- **Client:** React 18 + Vite + Tailwind + Vitest
- **Server:** Express (port 3001, also serves the built client in production)
- **No database.** In-memory only.
- **Anthropic API** for AI features (Groovy/mapping explanations only — never for facts).
- **Deployment:** Render (Node service). Environment variables: `ANTHROPIC_API_KEY`, `NODE_ENV=production`, `PORT=3001`.

---

## Repo layout

```
triggerflow_fixed/                    # folder name is legacy — project is "shipbridge"
├── package.json                      # name: "shipbridge", version: "36.0.0"
├── README.md
├── ROADMAP.md
├── PROJECT_CONTEXT.md                # <-- this file
├── server/
│   ├── index.js                      # Express server, all endpoints
│   ├── urlAllowlist.js               # shared *.hana.ondemand.com / *.sap.com allowlist
│   ├── cpiTrace.js                   # Real Trace: OAuth2 + MPL/TraceMessage OData fetch
│   ├── specDocx.js                   # DOCX generation via template substitution
│   └── spec_templates/
│       ├── motiveminds_template.docx # tokenized master (16 {{TOKEN}}s)
│       └── motiveminds_unpack/       # unpacked source
└── src/
    ├── App.jsx                       # main shell, page router, file upload
    ├── lib/
    │   ├── parser.js                 # iFlow ZIP → flow model (browser DOMParser)
    │   ├── specAdapters.js           # generic adapter field extractor (Layer A)
    │   ├── specProcessDirect.js      # cross-flow PD resolver (Layer A)
    │   └── redaction.js              # share-safe payload redaction (6 categories)
    └── components/
        ├── TraceViewer.jsx           # Real Trace 3-pane UI
        ├── Documentation.jsx         # Spec Builder (both default + upload paths)
        ├── LandingPage.jsx           # 3D landing, Real Trace as feature #01
        ├── LiveTrigger.jsx, Intelligence.jsx, Converter.jsx, Documentation.jsx, etc.
        └── landing/PipelineHero.jsx  # React Three Fiber + liquid-copper shader
```

---

## Current state — feature by feature

### ✅ Working end-to-end
- **Live Trigger** — OAuth2 + Basic Auth, host allowlist, custom headers.
- **Intelligence** — full cross-flow analysis on loaded ZIPs.
- **Converter** — all format conversions + pretty-print + download.
- **Documentation Spec Builder — Path A (Default Template):** Motiveminds format with 16 tokens. `POST /api/spec-docx` generates valid `.docx`. Verified end-to-end — sample output file exists.
- **Documentation Spec Builder — Path B (Upload Your Own):** user uploads `.docx` with `{{TOKEN}}` placeholders. `POST /api/spec-scan-template` returns detected tokens. UI auto-generates form. Same substitution engine.
- **59 unit tests pass** (Vitest). Build is clean.
- **Real Trace UI, redaction, Markdown export** — all built; the only thing not verified is the actual tenant response.

### 🟡 Real Trace — BLOCKED on BTP config, NOT a code problem

The Real Trace feature is fully built:
- `server/cpiTrace.js` — OAuth2 client_credentials + MPL OData + trace-message fetch
- 3 endpoints: `POST /api/cpi-trace/list`, `/fetch`, `/payload`
- Three-pane viewer (timeline / step detail / payload+redaction)
- Two-mode redaction: **Personal** (default, no masking) and **Share-safe** (required before AI/export)

**The blocker:** the user's CPI trial tenant service key was created on the `integration-flow` plan. The Message Processing Log OData API requires a service key on the **`api` plan** with the **`MonitoringRead` role**.

**The fix (needs user to do this in BTP Cockpit):**
1. BTP Cockpit → Instances and Subscriptions → Service Marketplace → **Process Integration Runtime**
2. Create NEW instance, **plan = `api`** (not `integration-flow`)
3. Create service key with JSON parameter: `{"roles": ["MonitoringRead"]}`
4. Paste the new credentials into ShipBridge's Real Trace → ⚙ Connection

Debug journey already done (don't redo):
- Original `-rt.` host is the RUNTIME URL — wrong for MPL API. Correct host is same tenant WITHOUT `-rt` and WITHOUT `-tmn` — plain `it-cpitrial05`. Confirmed via browser test that showed the API asking for auth.
- With plain host + old integration-flow service key → 401 Unauthorized.
- SAP Community thread confirmed: **`api` plan + `MonitoringRead` is the fix.**

### ❌ Not started (in priority order)
- Live Trigger → Real Trace auto-chain (correlation header injection)
- Multi-iFlow specs (main + all linked PD iFlows in one document)
- Version Compare (diff two iFlow ZIPs)
- Ticket Changes section in spec doc (with "Generate" AI button)
- Live Trigger profiles (DEV/QA/PROD) + request history
- Demo mode (sample iFlow, sample trace, no tenant needed)

---

## Locked design decisions (do not re-litigate)

1. **Extraction over AI for facts.** Adapter URLs, ProcessDirect paths, timeouts — always from XML. Never AI-generated. AI is only used for explanations/labels, never for facts. This is non-negotiable.
2. **No deploy/modify inside CPI.** ShipBridge only READS. It never deploys anything, never modifies iFlows.
3. **Credential storage.** `clientSecret` is React state only — gone on page refresh, never localStorage, never on server. Non-secret fields (tenantUrl, tokenUrl, clientId) are saved in browser localStorage so user doesn't re-type every time.
4. **"Not Provided" never lies.** If a value isn't available, show "Not Provided" or omit. Never invent.
5. **AI buttons are labeled "Generate"** — never "Draft with Claude."
6. **Brown-only palette.** No blue/green/red anywhere in the UI. Status colors are all brown shades, differentiated by text labels not color. `--blue` CSS variable name kept but repointed to `#d9a066` (copper).
7. **Template-base DOCX (not code-rebuilt).** Use user's real client `.docx` as master, substitute `{{TOKEN}}`s. Pixel-identical output. Do not code-generate documents from scratch.
8. **Two-mode redaction:** Personal (default in-app, no masking) and Share-safe (required toggle before any export or AI call).
9. **Screenshots are placed and captioned, never pixel-analyzed for facts.**
10. **Simulator deleted (v38).** Real Trace was verified against a live tenant first — that was the gate, and it was a one-way door.
11. **User communication style:** short, casual messages. Dislikes long preambles, dislikes re-asking questions when the answer is obvious. Prefers direct execution over extended planning discussions.

---

## The 4-week plan (LOCKED)

Full-time work from **Monday June 29, 2026** to delivery **Friday July 24, 2026** (~4 weeks). Deployed on Render.

- **Week 1 (Jun 29 – Jul 3):** Real Trace tenant verification (fix the api-plan blocker), Simulator removal.
- **Week 2 (Jul 6 – Jul 10):** Documentation dynamic sections completion, multi-iFlow specs.
- **Week 3 (Jul 13 – Jul 17):** Version Compare + Ticket Changes + Live Trigger profiles/history/redaction.
- **Week 4 (Jul 20 – Jul 24):** Deployment polish, demo mode, final testing, demo prep.

**Buffer:** through end of July if needed.

---

## Environment setup

### Local dev

```bash
cd triggerflow_fixed
npm install
npm run dev        # client + server together on their default ports
```

Requires `.env` file at project root with:
```
ANTHROPIC_API_KEY=sk-ant-...
```

(This file is gitignored — never commit it.)

### Production build

```bash
npm run build
node server/index.js    # serves the built client
```

### Testing

```bash
npx vitest run     # should show 59 tests passing
```

---

## Anthropic API key notes

- Lives in `.env` locally
- On Render: set as `ANTHROPIC_API_KEY` in the Environment Variables tab
- Never in git, never in code, never in localStorage
- Used by the Anthropic proxy endpoint in `server/index.js` for AI features only

---

## CPI Trial Tenant info (redacted)

- **Tenant:** `4ab21a6ctrial` on `us10` region
- **Runtime URL** (for firing messages, NOT for MPL API): `https://4ab21a6ctrial.it-cpitrial05-rt.cfapps.us10-001.hana.ondemand.com`
- **API URL** (for MPL trace API — plain host, no suffix): `https://4ab21a6ctrial.it-cpitrial05.cfapps.us10-001.hana.ondemand.com`
- **Token URL:** `https://4ab21a6ctrial.authentication.us10.hana.ondemand.com/oauth/token`

Available role collections on this trial (from BTP subaccount CSV):
- `PI_Administrator` → `AuthGroup_Administrator`
- `PI_Integration_Developer` → `AuthGroup_IntegrationDeveloper`
- `PI_Read_Only` → `AuthGroup_ReadOnly`
- `PI_Business_Expert` → `AuthGroup_BusinessExpert`

For Real Trace to work, need: NEW service instance on `api` plan (not `integration-flow`), created with parameter `{"roles": ["MonitoringRead"]}`.

---

## Where things stand — quick summary

- ✅ Deployed live on Render
- ✅ 5 modules working (Real Trace, Live Trigger, Intelligence, Converter, Documentation)
- ✅ Documentation both paths working end-to-end
- 🟡 Real Trace built, blocked on BTP api-plan config (user's action)
- ❌ Version Compare, Ticket Changes, Live Trigger profiles, demo mode — pending
- ⏳ 4-week plan to delivery July 24

---

## For AI assistants continuing this work

**Do this on session start:**
1. Read this file.
2. Check `package.json` version — if it's not v36+, ask before making changes.
3. Look at `README.md` for user-facing feature descriptions.
4. Look at `ROADMAP.md` for the priority list.
5. Run `npx vitest run` to confirm 59 tests pass baseline.

**Rules of engagement:**
- Follow the 11 locked design decisions above without re-asking.
- User values: real deliverables > planning docs, verified > untested, short commits > sprawling PRs.
- User's communication style: short, casual, direct. Don't write long preambles.
- If unsure about scope, ASK before building. Do not silently expand scope.
- One session = one shippable thing.

**Blocked features:**
- Real Trace requires BTP-side config (api plan service key with MonitoringRead). Not fixable in code.

**Common pitfalls to avoid:**
- Don't create alternative doc generators — the template-substitution engine is the answer.
- Don't try to code-rebuild the Motiveminds document from scratch — modify the tokenized master.
- Don't add unnecessary AI calls to features that should be deterministic.
- Don't rename the `triggerflow_fixed` folder — legacy but working; renaming breaks paths.
- Don't touch `LOCAL_HOSTS` or `CPI_HOST_PATTERNS` in `urlAllowlist.js` without understanding the security model.

---

## Contact / continuity

If this file is out of date compared to what you see in the code, TRUST THE CODE. Ask the user to update this file if needed.
