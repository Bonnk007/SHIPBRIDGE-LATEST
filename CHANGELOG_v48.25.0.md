# v48.25.0 — Pretty-print everywhere, XSD tuned for CPI

## Pretty-print gaps closed

Audit of every Converter action found two outputs that weren't formatted:

- **XSLT Transform** — output now runs through `prettyXML` (falls back to raw if the stylesheet uses `<xsl:output method="text"/>`).
- **Markdown → HTML** — output now indented by a small in-house HTML formatter (handles void elements and self-closing tags; not a general HTML pretty-printer, just enough that marked's output is legible instead of one long line).

Every other action was already pretty by design: XML pretty/minify (minify is intentional), JSON pretty/minify, YAML pretty, all `→ JSON` paths use `JSON.stringify(…, null, 2)`, all `→ XML` paths flow through the fixed `jsonToXML` from v48.24, XSD emitters are indented.

## XSD improvements — CPI import expectations

Based on SAP Community threads about XSD import into Message Mapping:

- **`elementFormDefault="qualified"` always emitted.** Was only present when a namespace was set. CPI's mapping editor is happier when this is always on.
- **`xs:annotation` header** added, explaining the schema is generated from a sample and should be reviewed. Helps the next developer understand what they're editing.
- **`targetNamespace` UI field.** Optional text input visible when either XSD action is selected. Blank produces a no-namespace schema; filling it in produces `targetNamespace="…"` + `xmlns="…"` together, which is what CPI's mapping editor expects when the namespace prefix is used.

## Tests

223 passing (was 217; +6 for XSD structure matching CPI expectations: `elementFormDefault` always present, exactly one global root element, `maxOccurs="unbounded"` on repeated siblings, `xs:annotation` header, targetNamespace round-trip, generated XSD is itself valid XML).

## Honest limits

- The HTML formatter is intentionally basic. If you need to hand-edit large HTML output, use a real formatter downstream.
- XSD still doesn't infer `xs:pattern` or `xs:enumeration` — those are add-by-hand refinements.
- XSD is still a starting point. The annotation header now says so.
