# v48.24.0 — Converter: XML pretty-print fix + XSD generation

## Fixed

- **JSON → XML now pretty-prints properly.** Previous versions emitted every tag at column zero regardless of nesting. Now indented with 2 spaces per level, matching the rest of Converter.
- **JSON → XML now produces valid XML.** Numeric JSON keys (e.g. `"3"`, `"12184"`) were being written as `<3>` and `<12184>`, which is invalid XML — element names cannot start with a digit per XML 1.0 §2.3. Now sanitized: `"3"` → `<_3>`, `"has space"` → `<has_space>`, etc. This matches what CPI's own JSON-to-XML converter does. **If you generated XML with any earlier version and imported it into CPI, regenerate it — the old output would have been rejected by any XML parser.**

## Added

- **XML → XSD** action in Converter. Paste XML, get a starting-point schema. Infers `xs:integer`, `xs:decimal`, `xs:boolean`, `xs:date`, `xs:dateTime`, `xs:string`. Detects optional and repeated elements and marks them with `minOccurs="0"` / `maxOccurs="unbounded"`. Downloadable as `.xsd`.
- **JSON → XSD** action in Converter. Uses the same shape inference — internally goes JSON → XML → XSD so both paths produce identical schemas from equivalent input.

## Not built

- Namespace input in the UI — kept off for now, `targetNamespace` is an argument on `xmlToXSD()` but not yet exposed. Add later if the demo asks for it.
- XSD → XML sample generator — the reverse direction. Different feature, different session.

## Why

Answers the SAP Community pain point about no built-in "sample payload to schema" step — developers currently paste XML into freeformatter.com or Notepad++ plugins. See the "Graphical XSD Builder & XML To XSD Converter" community blog for the same gap.

## Honest limits (shown in the UI later)

- Inferred schemas are always looser than hand-authored ones. A field that's numeric in every sample might legitimately be a string in production.
- No `xs:pattern` restrictions inferred — add those by hand for code fields.
- No shared type extraction — every complex type is inlined.
- Treat as a starting point, review before deploying.

## Tests

217 passing (was 208; +9 for XSD type inference, safe-name sanitization, and the exact JSON from the user's screenshot round-tripping through a real XML parser without errors).
