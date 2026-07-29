import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry } from '../index'

// MongoDB array-field semantics: a scalar equality filter matches documents
// whose array field CONTAINS the value ({ labels: 'x' } matches ['x', 'y']).
// This must hold on the linear-scan matcher, on the index-hinted path
// (multikey index expansion) and inside aggregation $match.
test('Array field queries', async t => {
  t.beforeEach(async () => await clearRegistry())

  const makeModel = (name: string, indexed: boolean) => {
    const schema = new Schema({
      employeeId: Number,
      labels: indexed ? { type: [String], index: true } : [String]
    })
    return model(name, schema)
  }

  await t.test('scalar equality matches array elements (linear scan)', async () => {
    const M = makeModel('ArrPlain', false)
    await M.insertMany([
      { employeeId: 1, labels: ['a', 'b'] },
      { employeeId: 2, labels: ['b'] }
    ])
    assert.strictEqual((await M.find({ labels: 'a' })).length, 1)
    assert.strictEqual(await M.countDocuments({ labels: 'b' }), 2)
    assert.strictEqual((await M.findOne({ labels: 'a' }))?.employeeId, 1)
  })

  await t.test('scalar equality matches array elements (indexed field, multikey)', async () => {
    const M = makeModel('ArrIndexed', true)
    await M.insertMany([
      { employeeId: 1, labels: ['a', 'b'] },
      { employeeId: 2, labels: ['b', 'c'] }
    ])
    assert.strictEqual((await M.find({ labels: 'a' })).length, 1)
    assert.strictEqual((await M.find({ labels: 'b' })).length, 2)
    assert.strictEqual((await M.find({ labels: 'c' })).length, 1)
    assert.strictEqual(await M.countDocuments({ labels: 'nope' }), 0)
  })

  await t.test('multikey index stays consistent through $addToSet updates', async () => {
    const M = makeModel('ArrUpdated', true)
    await M.create({ employeeId: 1, labels: ['a'] })
    await M.updateOne({ employeeId: 1 }, { $addToSet: { labels: 'b' } })
    assert.strictEqual((await M.find({ labels: 'a' })).length, 1)
    assert.strictEqual((await M.find({ labels: 'b' })).length, 1)
    // re-adding an existing element must not duplicate index entries
    await M.updateOne({ employeeId: 1 }, { $addToSet: { labels: 'b' } })
    assert.strictEqual((await M.find({ labels: 'b' })).length, 1)
  })

  await t.test('aggregation $match applies array-contains semantics', async () => {
    const M = makeModel('ArrAgg', false)
    await M.insertMany([
      { employeeId: 1, labels: ['l1'] },
      { employeeId: 2, labels: ['l1', 'l2'] },
      { employeeId: 3, labels: ['l2'] }
    ])
    const rows = await M.aggregate([
      { $match: { labels: 'l1' } },
      { $group: { _id: '$labels', value: { $sum: 1 } } }
    ])
    const total = rows.reduce((sum: number, r) => sum + Number(r.value), 0)
    assert.strictEqual(total, 2)
  })

  await t.test('$ne excludes documents whose array contains the value', async () => {
    const M = makeModel('ArrNe', false)
    await M.insertMany([
      { employeeId: 1, labels: ['a', 'b'] },
      { employeeId: 2, labels: ['c'] }
    ])
    const rows = await M.find({ labels: { $ne: 'a' } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 2)
  })

  await t.test('whole-array equality matches element-wise, not by reference', async () => {
    const M = makeModel('ArrWhole', false)
    await M.insertMany([
      { employeeId: 1, labels: ['a', 'b'] },
      { employeeId: 2, labels: ['b', 'a'] }
    ])
    const rows = await M.find({ labels: ['a', 'b'] })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 1)
  })
})
