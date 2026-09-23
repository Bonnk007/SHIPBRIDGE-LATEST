// Bridge between two naming conventions inside a parsed iFlow:
//
//   - The dependency index keys assets by config-level refs from the .iflw
//     XML — e.g. `mappingRef="MM_Order"`, `xsltRef="Transform"`. Those refs
//     are usually the bare artifact name.
//   - The parser stores contents keyed by the actual filename inside the
//     ZIP — e.g. `MM_Order.mmap`, `Transform.xsl`.
//
// Without this helper, "pick a mapping in Intelligence" would fail to
// resolve content on every real iFlow, because the ref won't match the
// filename verbatim. The lookup tries the strictest matches first and only
// falls back to substring when nothing else works.
export function fuzzyLookup(dict, name) {
  if (!dict || !name) return null
  if (dict[name] !== undefined) return dict[name]

  // Try common extensions the ref might be missing
  for (const ext of ['.mmap', '.xml', '.vmap']) {
    if (dict[name + ext] !== undefined) return dict[name + ext]
  }

  // Or the ref might carry an extension the key doesn't
  const bare = name.replace(/\.(mmap|xml|vmap)$/i, '')
  if (dict[bare] !== undefined) return dict[bare]

  // Last resort: substring, matched against both sides' bare form. Kept
  // last because it's the only lookup that could return a wrong entry if
  // two assets share a stem; ordering above means we only reach here when
  // none of the strict paths matched. The MIN_LEN guard stops a single-
  // letter or too-short bare name from matching by accident — the substring
  // test is inherently loose, and without this a query for "a" would match
  // any dictionary key.
  const MIN_LEN = 3
  for (const [k, v] of Object.entries(dict)) {
    const kBare = k.replace(/\.(mmap|xml|vmap)$/i, '')
    if (kBare === bare) return v
    if (kBare.length >= MIN_LEN && bare.length >= MIN_LEN &&
        (kBare.includes(bare) || bare.includes(kBare))) return v
  }
  return null
}
