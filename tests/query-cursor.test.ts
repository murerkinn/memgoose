import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry, QueryCursor } from '../index'

// find(...).cursor(): async-iterable cursor with next()/close()/eachAsync(),
// honoring the builder's sort/limit/skip/lean options.
test('Query cursor', async t => {
  t.beforeEach(async () => await clearRegistry())

  const seed = async (name: string) => {
    const M = model(name, new Schema({ n: Number, tag: String }))
    await M.insertMany([1, 2, 3, 4, 5].map(n => ({ n, tag: n % 2 ? 'odd' : 'even' })))
    return M
  }

  await t.test('iterates with for await honoring sort and limit', async () => {
    const M = await seed('CursorIterate')
    const seen: number[] = []
    for await (const doc of M.find({}).sort({ n: -1 }).limit(3).cursor()) {
      seen.push(doc.n as number)
    }
    assert.deepStrictEqual(seen, [5, 4, 3])
  })

  await t.test('next() returns documents then null', async () => {
    const M = await seed('CursorNext')
    const cursor = M.find({ tag: 'odd' }).sort({ n: 1 }).cursor()
    assert.strictEqual((await cursor.next())?.n, 1)
    assert.strictEqual((await cursor.next())?.n, 3)
    assert.strictEqual((await cursor.next())?.n, 5)
    assert.strictEqual(await cursor.next(), null)
    assert.strictEqual(await cursor.next(), null)
  })

  await t.test('close() ends iteration early', async () => {
    const M = await seed('CursorClose')
    const cursor = M.find({}).sort({ n: 1 }).cursor()
    assert.strictEqual((await cursor.next())?.n, 1)
    await cursor.close()
    assert.strictEqual(await cursor.next(), null)
  })

  await t.test('eachAsync visits every document in order', async () => {
    const M = await seed('CursorEach')
    const seen: number[] = []
    await M.find({})
      .sort({ n: 1 })
      .cursor()
      .eachAsync(async doc => {
        seen.push(doc.n as number)
      })
    assert.deepStrictEqual(seen, [1, 2, 3, 4, 5])
  })

  await t.test('breaking out of for await closes the cursor', async () => {
    const M = await seed('CursorBreak')
    const cursor = M.find({}).sort({ n: 1 }).cursor()
    for await (const doc of cursor) {
      if (doc.n === 2) break
    }
    assert.strictEqual(await cursor.next(), null)
  })

  await t.test('an empty result set yields null immediately', async () => {
    const M = await seed('CursorEmpty')
    const cursor = M.find({ n: 99 }).cursor()
    assert.strictEqual(await cursor.next(), null)
  })

  await t.test('concurrent next() calls share a single fetch', async () => {
    let fetches = 0
    const cursor = new QueryCursor(async () => {
      fetches++
      return ['a', 'b']
    })
    const [first, second] = await Promise.all([cursor.next(), cursor.next()])
    assert.strictEqual(fetches, 1)
    assert.deepStrictEqual([first, second].sort(), ['a', 'b'])
  })

  await t.test('eachAsync passes the document index', async () => {
    const M = await seed('CursorEachIndex')
    const indices: number[] = []
    await M.find({})
      .sort({ n: 1 })
      .limit(3)
      .cursor()
      .eachAsync((_doc, index) => {
        indices.push(index)
      })
    assert.deepStrictEqual(indices, [0, 1, 2])
  })

  await t.test('lean() carries through the cursor', async () => {
    const M = await seed('CursorLean')
    const cursor = M.find({ n: 1 }).lean().cursor()
    const doc = await cursor.next()
    assert.strictEqual(doc?.n, 1)
    assert.strictEqual(typeof (doc as { save?: unknown })?.save, 'undefined')
  })
})
