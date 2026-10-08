# v48.26.0 — Pretty print button (visible) + XSD dedicated panel

## Pretty print

The output-header "✨ Pretty" button was already present but underused — worth calling out that it's there and what it does. It runs `prettifyAny(output)`:
- JSON → `JSON.stringify(…, null, 2)`
- XML / XSD / valid HTML → `prettyXML`
- Marked-style HTML → the in-house `prettyHTML` indenter
- YAML → `yaml.dump`
- CSV / plain text → left untouched (destroying tabular data would be worse than not formatting it)

Auto-picks by first character. Detection order matters: XML/XSD/HTML all start with `<`, so structured XML is tried first; the HTML fallback catches anything the XML parser rejects.

## XSD moved from dropdown to dedicated panel

Removed the `→ XSD (schema)` items from the XML and JSON action dropdowns. Added a **"Generate XSD →"** button next to the primary Convert button.

Clicking it opens a modal panel with:
- **Detected input** indicator — auto-shows XML, JSON, or "no XML/JSON detected" (button disabled)
- **Root element name** input (only shown when input is JSON — XML already has a root)
- **Target namespace** input with helper text explaining it's optional but recommended for CPI Message Mapping
- A summary of what the generated XSD guarantees: `elementFormDefault="qualified"` always, single global root, inferred types
- Generate / Cancel buttons

The panel closes on Generate (result appears in the Output pane) or Cancel/backdrop click. Also closes on any error, surfacing the error in the usual error slot.

## Why a modal instead of two dropdown items

XSD generation needs two inputs the other conversions don't (root name for JSON input, targetNamespace). Cramming them into the main action row made the toolbar noisy. A dedicated panel is discoverable — "Generate XSD" is a real thing developers look for — and gets out of the way for the eight other conversions that don't need it.

## Tests

229 passing (was 223; +6 for XSD panel behavior tests earlier + component wiring changes cleanly compile with all existing tests still green).
