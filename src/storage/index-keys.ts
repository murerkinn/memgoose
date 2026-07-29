/**
 * Compute the composite index key(s) for a document. Array-valued fields are
 * expanded per element (multikey semantics, matching MongoDB): a document with
 * labels ['a', 'b'] under an index on labels is findable through key 'a' and
 * through key 'b'. Scalar-only documents produce exactly one key, so behavior
 * for non-array fields is unchanged.
 *
 * With skipNullish (WiredTiger behavior), a null/undefined field value means
 * the document is not indexed at all ([] is returned).
 */
export function computeIndexKeys(
  source: Record<string, unknown>,
  fields: ReadonlyArray<string | number | symbol>,
  options?: { skipNullish?: boolean }
): string[] {
  let keyParts: string[][] = [[]]
  for (const field of fields) {
    const value = source[field as string]
    if (options?.skipNullish && (value === undefined || value === null)) return []
    const variants =
      Array.isArray(value) && value.length > 0 ? value.map(v => String(v)) : [String(value)]
    keyParts = keyParts.flatMap(parts => variants.map(v => [...parts, v]))
  }
  // Dedupe: a doc with labels ['a', 'a'] must appear once per bucket, not twice
  return [...new Set(keyParts.map(parts => parts.join(':')))]
}
