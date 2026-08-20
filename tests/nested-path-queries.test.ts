import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry } from '../index'

// MongoDB dotted-path semantics: { 'processing.status': 'pending' } reads
// doc.processing.status; { 'quality.gatedAt': { $exists: false } } checks the
// nested field; array segments project across elements.
test('Nested dotted-path queries', async t => {
  t.beforeEach(async () => await clearRegistry())

  await t.test('equality on a nested subdocument field', async () => {
    const M = model(
      'NestedEq',
      new Schema({ name: String, processing: new Schema({ status: String }) })
    )
    await M.insertMany([
      { name: 'a', processing: { status: 'pending' } },
      { name: 'b', processing: { status: 'processed' } }
    ])
    const rows = await M.find({ 'processing.status': 'pending' })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].name, 'a')
    assert.strictEqual(await M.countDocuments({ 'processing.status': 'processed' }), 1)
  })

  await t.test('$exists on a nested field, including after updateMany', async () => {
    const M = model(
      'NestedExists',
      new Schema({ name: String, quality: Schema.Types.Mixed })
    )
    await M.create({ name: 'x' })
    const first = await M.updateMany(
      { 'quality.gatedAt': { $exists: false } },
      { $set: { quality: { score: 10, gatedAt: new Date() } } }
    )
    assert.strictEqual(first.modifiedCount, 1)
    const second = await M.updateMany(
      { 'quality.gatedAt': { $exists: false } },
      { $set: { quality: { score: 0, gatedAt: new Date() } } }
    )
    assert.strictEqual(second.modifiedCount, 0)
  })

  await t.test('array segments project across elements', async () => {
    const M = model(
      'NestedArr',
      new Schema({ name: String, experience: [Schema.Types.Mixed] })
    )
    await M.insertMany([
      { name: 'match', experience: [{ company_id: 1 }, { company_id: 2 }] },
      { name: 'other', experience: [{ company_id: 3 }] }
    ])
    const rows = await M.find({ 'experience.company_id': 2 })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].name, 'match')
  })

  await t.test('an index on a nested path stays consistent with query results', async () => {
    const schema = new Schema({ name: String, processing: Schema.Types.Mixed })
    schema.index({ 'processing.status': 1 })
    const M = model('NestedIndexed', schema)
    await M.insertMany([
      { name: 'a', processing: { status: 'pending' } },
      { name: 'b', processing: { status: 'pending' } },
      { name: 'c', processing: { status: 'processed' } }
    ])
    assert.strictEqual((await M.find({ 'processing.status': 'pending' })).length, 2)
    await M.updateOne({ name: 'a' }, { $set: { processing: { status: 'processed' } } })
    assert.strictEqual((await M.find({ 'processing.status': 'pending' })).length, 1)
    assert.strictEqual((await M.find({ 'processing.status': 'processed' })).length, 2)
  })
})
