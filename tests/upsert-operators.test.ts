import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry } from '../index'

// MongoDB upsert-operator semantics: $setOnInsert participates when the upsert
// inserts (and is ignored on plain updates); $addToSet / $push create the
// array when the field is missing instead of silently doing nothing.
test('Upsert update operators', async t => {
  t.beforeEach(async () => await clearRegistry())

  const makeModel = (name: string) =>
    model(
      name,
      new Schema({
        employeeId: { type: Number, required: true },
        raw: { type: Schema.Types.Mixed, required: true },
        labels: { type: [String], default: [] }
      })
    )

  await t.test('upsert insert applies $setOnInsert and $addToSet together', async () => {
    const M = makeModel('UpsertLand')
    const res = await M.updateOne(
      { employeeId: 1 },
      { $setOnInsert: { employeeId: 1, raw: { a: 1 } }, $addToSet: { labels: 'cohort-a' } },
      { upsert: true }
    )
    assert.strictEqual(res.upsertedCount, 1)
    const doc = await M.findOne({ employeeId: 1 }).lean()
    assert.deepStrictEqual(doc?.raw, { a: 1 })
    assert.deepStrictEqual(doc?.labels, ['cohort-a'])
  })

  await t.test('re-running the upsert only adds the new label, never touches raw', async () => {
    const M = makeModel('UpsertReland')
    const update = (label: string) => ({
      $setOnInsert: { employeeId: 2, raw: { original: true } },
      $addToSet: { labels: label }
    })
    await M.updateOne({ employeeId: 2 }, update('a'), { upsert: true })
    const second = await M.updateOne(
      { employeeId: 2 },
      { $setOnInsert: { employeeId: 2, raw: { CLOBBERED: true } }, $addToSet: { labels: 'b' } },
      { upsert: true }
    )
    assert.strictEqual(second.upsertedCount ?? 0, 0)
    assert.strictEqual(second.modifiedCount, 1)
    const doc = await M.findOne({ employeeId: 2 }).lean()
    assert.deepStrictEqual(doc?.raw, { original: true })
    assert.deepStrictEqual([...(doc?.labels ?? [])].sort(), ['a', 'b'])
    assert.strictEqual(await M.countDocuments({ employeeId: 2 }), 1)
  })

  await t.test('$addToSet and $push create the array on documents missing the field', async () => {
    const M = model('ArrCreate', new Schema({ name: String }))
    await M.create({ name: 'x' })
    await M.updateOne({ name: 'x' }, { $addToSet: { tags: 'a' } })
    await M.updateOne({ name: 'x' }, { $push: { history: 'h1' } })
    const doc = (await M.findOne({ name: 'x' }).lean()) as Record<string, unknown> | null
    assert.deepStrictEqual(doc?.tags, ['a'])
    assert.deepStrictEqual(doc?.history, ['h1'])
  })
})
