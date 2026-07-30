import { test } from 'node:test'
import assert from 'node:assert'
import { computeIndexKeys } from '../src/storage/index-keys'

// Pins the key contract through the scalar fast path and the multikey
// expansion: both branches must produce identical keys for the same input.
test('computeIndexKeys', async t => {
  await t.test('single scalar field produces one plain key', () => {
    assert.deepStrictEqual(computeIndexKeys({ email: 'a@x.com' }, ['email']), ['a@x.com'])
    assert.deepStrictEqual(computeIndexKeys({ n: 42 }, ['n']), ['42'])
    assert.deepStrictEqual(computeIndexKeys({}, ['missing']), ['undefined'])
    assert.deepStrictEqual(computeIndexKeys({ v: null }, ['v']), ['null'])
  })

  await t.test('compound scalar fields join with a colon in field order', () => {
    assert.deepStrictEqual(computeIndexKeys({ a: 'x', b: 2 }, ['a', 'b']), ['x:2'])
    assert.deepStrictEqual(computeIndexKeys({ a: 'x', b: 2 }, ['b', 'a']), ['2:x'])
  })

  await t.test('dotted paths resolve nested fields', () => {
    assert.deepStrictEqual(
      computeIndexKeys({ processing: { status: 'pending' } }, ['processing.status']),
      ['pending']
    )
  })

  await t.test('array field expands to one key per element (multikey)', () => {
    assert.deepStrictEqual(computeIndexKeys({ labels: ['a', 'b'] }, ['labels']), ['a', 'b'])
  })

  await t.test('array duplicates dedupe to one key', () => {
    assert.deepStrictEqual(computeIndexKeys({ labels: ['a', 'a'] }, ['labels']), ['a'])
  })

  await t.test('compound with one array field expands the cartesian product', () => {
    assert.deepStrictEqual(
      computeIndexKeys({ labels: ['a', 'b'], city: 'x' }, ['labels', 'city']),
      ['a:x', 'b:x']
    )
  })

  await t.test('empty array falls back to a single stringified key', () => {
    assert.deepStrictEqual(computeIndexKeys({ labels: [], city: 'x' }, ['labels', 'city']), [':x'])
  })

  await t.test('skipNullish drops unindexable documents entirely', () => {
    assert.deepStrictEqual(computeIndexKeys({}, ['email'], { skipNullish: true }), [])
    assert.deepStrictEqual(computeIndexKeys({ email: null }, ['email'], { skipNullish: true }), [])
    assert.deepStrictEqual(computeIndexKeys({ email: 'a' }, ['email'], { skipNullish: true }), [
      'a'
    ])
  })

  await t.test('skipNullish applies per field on compound indexes', () => {
    assert.deepStrictEqual(computeIndexKeys({ a: 'x' }, ['a', 'b'], { skipNullish: true }), [])
    assert.deepStrictEqual(computeIndexKeys({ a: 'x', b: 1 }, ['a', 'b'], { skipNullish: true }), [
      'x:1'
    ])
  })

  await t.test('skipNullish lets array values through to multikey expansion', () => {
    assert.deepStrictEqual(
      computeIndexKeys({ labels: ['a', 'b'] }, ['labels'], { skipNullish: true }),
      ['a', 'b']
    )
  })

  await t.test('a zero-field index keeps the historical empty key', () => {
    assert.deepStrictEqual(computeIndexKeys({ a: 1 }, []), [''])
  })
})
