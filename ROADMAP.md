# ShipBridge Roadmap

Status legend: ✅ shipped · 🔜 next · 🧭 planned

## Live Trigger
- ✅ Send payloads to deployed endpoints (OAuth2 / Basic Auth, custom headers)
- ✅ Inline response with status, timing
- 🔜 Environment profiles (DEV / QA / PROD) storing non-secret config
- 🔜 Request history (timestamp, endpoint, status, duration, sizes — no secrets)
- 🧭 Payload library (valid / invalid / edge-case / high-value / empty-optional)

## Intelligence
- ✅ Shared scripts and mappings, ProcessDirect links, dead assets, cycles
- ✅ Impact query ("what breaks if I change this?")
- 🔜 Export Impact Report (shared assets, broken links, dead assets, cycles, most complex flows)
- 🧭 Graph filters (ProcessDirect only, Groovy deps, broken links, shared assets, circular chains)

## Spec Builder
- ✅ Section-based builder auto-filled from the parsed iFlow
- ✅ Image upload zones (architecture, scenario, error, UAT)
- ✅ Export to Word (.docx)
- 🔜 Generate from company DOCX template (exact logo/format match)
- 🔜 AI auto-fill for purpose, scope, scenario description
- 🧭 Mapping summary and test-case suggestions

## Security & Deployment
- ✅ Local iFlow parsing, server-side host allowlist, no secret storage
- 🔜 Client-safe redaction ("Redact for sharing" — hide tenant URLs, usernames, credentials, hostnames)
- 🔜 AI usage transparency panel ("what is sent to AI?")
- 🔜 Demo mode (safe sample iFlow, payloads, dependency results — no real tenant data)
- 🧭 Docker packaging for self-hosting
- 🧭 Optional accounts, shareable links, run history (requires backend datastore)
