# ShipBridge

**ShipBridge helps SAP CPI developers test, trace, analyze, and document iFlows from one workspace.**

ShipBridge is a developer toolkit for SAP Cloud Integration (CPI). Export your iFlows, drop the ZIPs in, and trace how a message moves through every step — before you redeploy. Fire real payloads at deployed endpoints, map dependencies across your package, and generate a Technical Specification document, all in one place.

Everything is parsed locally in your browser. The only data that leaves your machine is what you explicitly send: script/payload snippets for AI analysis, and Live Trigger requests to the tenant you point at.

---

## Modules

### Real Trace — *the CPI black-box flight recorder*
Connect to your CPI tenant with a BTP service key, pick a recent message (or paste a MessageGuid), and read the actual trace: real payloads at each step, headers and properties, error context on failed steps, timing per step. Every trace step is mapped back to your parsed iFlow design so you see the script name, mapping name, adapter type, and ProcessDirect address alongside CPI's runtime data.

Two modes for redaction: Personal (no masking, your own debug view) and Share-safe (required before export or AI — masks credentials, tokens, hostnames, tenant URLs, emails, client IDs).

Requires Trace log level enabled on the iFlow in CPI Web UI (auto-resets after 10 minutes).

### Live Trigger — *test deployed iFlows without a sender system*
Send payloads directly to a deployed CPI endpoint with OAuth2 or Basic Auth and custom headers. No Postman setup, no sender system required. Responses come back inline.

### Intelligence — *know what breaks before you change it*
Index every loaded flow and answer the question every CPI architect asks: *if I change this script, what stops working?* Surfaces shared scripts and mappings, ProcessDirect links, dead assets, and circular dependencies.

### Converter — *reshape payloads while you work*
Convert between XML, JSON, CSV, YAML, run XSLT transforms, and render Markdown. Pretty-print and download.

### Spec Builder — *turn an iFlow into a Technical Specification*
Auto-fill a CPI specification document from the parsed iFlow — components, data flow, error handling — upload screenshots, answer a few questions, and export to Word in your company template.

### Checkpoint *(experimental)*
An advanced runtime checkpoint that pauses a real CPI iFlow and streams its state into ShipBridge. Requires adding a Groovy script to your iFlow. Experimental — not needed for normal tracing.

---

## Setup

```bash
npm install
npm run dev        # runs client (Vite) + server (Express) together
```

The client runs on the Vite dev port; the API server runs on `http://localhost:3001`.

For AI features (Groovy/mapping prediction, the CPI Assistant, Spec Builder generation), add an Anthropic API key:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6   # optional
```

Build for production:

```bash
npm run build
NODE_ENV=production npm start       # server serves the built client
```

---

## Security notes

- **iFlow parsing is local.** ZIPs are unpacked and analyzed in the browser; the files are not uploaded to a server.
- **What is sent to AI:** script and payload snippets for the steps you analyze, plus questionnaire context for Spec Builder. Do not use sensitive production data — use masked payloads for client demos.
- **Live Trigger talks to a real tenant.** Requests go to the host you configure, through a server-side allowlist. Credentials are used per-request and are not persisted.
- **Real Trace credentials.** The CPI service-key Client Secret stays in browser memory only — cleared on page refresh, never written to disk. The non-secret values (tenant URL, token URL, client ID) are saved locally so you don't re-type them every time.
- **No secrets are stored server-side.** All tenant credentials live on your machine. The Express server never logs request bodies that contain credentials.

---

## AI limitations

ShipBridge is a developer tool, not a CPI runtime clone.

- Written prose in generated specifications is **AI-assisted**. Facts in those documents — step order, adapter configuration, Content Modifier tables, Groovy source, credential aliases — are extracted from the iFlow XML, never generated.
- AI explanations describe *what* a flow appears to do, not the business *why* — always review Spec Builder output before sending to a client.
- Deterministic steps (Content Modifier, Router, Filter, Splitter/Gather) are computed directly and are not AI-predicted.

---

## Support matrix

| CPI Step | Support |
|---|---|
| Content Modifier | Deterministic |
| Router | Deterministic / Partial |
| Filter | Deterministic |
| Splitter / Gather | Deterministic |
| Groovy Script | AI predicted |
| Message Mapping | AI predicted |
| XSLT Mapping | AI predicted |
| ProcessDirect | Linked |
| Request-Reply / External call | Mock |
| Exception Subprocess | Parsed / partial |
