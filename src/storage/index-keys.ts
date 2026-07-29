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

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/** Update paths must never traverse the prototype chain (prototype pollution). */
function assertSafeDocumentPath(path: string): void {
  if (path.split('.').some(segment => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    throw new Error(`Unsafe document path: ${path}`)
  }
}

/**
 * Non-projecting read for update operators: walks embedded documents and
 * numeric array indices. Unlike resolveDocumentPath it never projects across
 * array elements — update paths address exactly one slot.
 */
export function getDocumentPathValue(source: unknown, path: string): unknown {
  assertSafeDocumentPath(path)
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Sets a dotted path, creating intermediate embedded documents as needed —
 * $set semantics: "If you specify a dotted path for a non-existent field,
 * $set creates the embedded documents as needed to fulfill the dotted path".
 */
export function setDocumentPathValue(
  target: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  assertSafeDocumentPath(path)
  const segments = path.split('.')
  let current: Record<string, unknown> = target
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i]]
    if (next === null || next === undefined || typeof next !== 'object') {
      const created: Record<string, unknown> = {}
      current[segments[i]] = created
      current = created
    } else {
      current = next as Record<string, unknown>
    }
  }
  current[segments[segments.length - 1]] = value
}

/**
 * Deletes a dotted-path leaf — $unset semantics. On array elements MongoDB
 * nulls the slot instead of removing it; embedded-document leaves are deleted.
 */
export function deleteDocumentPathValue(target: Record<string, unknown>, path: string): void {
  assertSafeDocumentPath(path)
  const segments = path.split('.')
  let current: unknown = target
  for (let i = 0; i < segments.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') return
    current = (current as Record<string, unknown>)[segments[i]]
  }
  if (current === null || current === undefined || typeof current !== 'object') return
  const leaf = segments[segments.length - 1]
  if (Array.isArray(current)) {
    const idx = Number(leaf)
    if (Number.isInteger(idx) && idx >= 0 && idx < current.length) current[idx] = null
    return
  }
  delete (current as Record<string, unknown>)[leaf]
}
