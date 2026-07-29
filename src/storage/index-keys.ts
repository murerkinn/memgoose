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
/**
 * Resolve a (possibly dotted) document path — 'processing.status' reads
 * doc.processing.status. Arrays along the path project the segment across
 * elements (MongoDB multikey path semantics), so 'experience.company_id'
 * over an experience array yields every element's company_id.
 */
export function resolveDocumentPath(source: unknown, path: string): unknown {
  if (typeof path !== 'string' || !path.includes('.')) {
    return (source as Record<string, unknown>)[path as string]
  }
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const projected = current
        .map(el => (el && typeof el === 'object' ? (el as Record<string, unknown>)[segment] : undefined))
        .filter(v => v !== undefined)
      current = projected.length > 0 ? projected.flat() : undefined
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function computeIndexKeys(
  source: Record<string, unknown>,
  fields: ReadonlyArray<string | number | symbol>,
  options?: { skipNullish?: boolean }
): string[] {
  let keyParts: string[][] = [[]]
  for (const field of fields) {
    const value = resolveDocumentPath(source, String(field))
    if (options?.skipNullish && (value === undefined || value === null)) return []
    const variants =
      Array.isArray(value) && value.length > 0 ? value.map(v => String(v)) : [String(value)]
    keyParts = keyParts.flatMap(parts => variants.map(v => [...parts, v]))
  }
  // Dedupe: a doc with labels ['a', 'a'] must appear once per bucket, not twice
  return [...new Set(keyParts.map(parts => parts.join(':')))]
}
