# v48.27.0 — Output pane is now editable

## Fixed

- **Output pane was `readOnly`.** Every conversion, XSD included, dumped a result you couldn't edit — you'd have to copy it out, paste back into Input, and re-convert. Removed the `readOnly`. Placeholder updated to `"Result will appear here after clicking Convert… (editable)"`.

## Why it matters

- **XSD** — generated schemas are always a starting point. Users need to add `xs:pattern`, `xs:enumeration`, adjust `minOccurs`, add `xs:documentation`, rename elements. Now they can do all of that without leaving the pane.
- **Every other format** benefits the same way. Tweak an XML value, adjust a JSON field, fix a YAML indent — no round-trip through the Input pane.
- **Pretty print button** still works — it re-formats whatever's in the output, so you can edit freely then re-format.
- **Char count** stays live thanks to controlled `onChange` binding.

## What still works

- Copy, Download, and Swap (⇄) all read from the current output value.
- Re-clicking Convert overwrites your edits — expected, since Convert regenerates from the input.

## Tests

229 passing — the change is UI-only, no logic touched.
