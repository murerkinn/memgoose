import { test } from 'node:test'
import assert from 'node:assert'
import { connect, model, Schema, disconnect } from '../index'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DATA_PATH = './test-sqlite-bulkwrite-data'

async function cleanupTestData() {
  if (fs.existsSync(TEST_DATA_PATH)) {
    const files = fs.readdirSync(TEST_DATA_PATH)
    for (const file of files) {
      fs.unlinkSync(path.join(TEST_DATA_PATH, file))
    }
    fs.rmdirSync(TEST_DATA_PATH)
  }
}

// bulkWrite over a storage with a native update fast path: the native result
// reports no matchedCount of its own, which once made updateMany+upsert
// double-apply the update and fabricate an upsert.
test('Model.bulkWrite on SQLite storage', async t => {
  t.beforeEach(async () => {
    await cleanupTestData()
    connect({ storage: 'sqlite', sqlite: { dataPath: TEST_DATA_PATH } })
  })

  t.afterEach(async () => {
    await disconnect()
    await cleanupTestData()
  })

  await t.test('updateMany with upsert applies the update exactly once', async () => {
    const M = model('BulkSqlite', new Schema({ employeeId: Number, hits: Number, tag: String }))
    await M.insertMany([
      { employeeId: 1, hits: 1, tag: 'x' },
      { employeeId: 2, hits: 1, tag: 'x' }
    ])
    const res = await M.bulkWrite([
      { updateMany: { filter: { tag: 'x' }, update: { $inc: { hits: 1 } }, upsert: true } }
    ])
    assert.strictEqual(res.matchedCount, 2)
    assert.strictEqual(res.modifiedCount, 2)
    assert.strictEqual(res.upsertedCount, 0)
    const docs = await M.find({ tag: 'x' }).sort({ employeeId: 1 })
    assert.deepStrictEqual(
      docs.map(d => d.hits),
      [2, 2]
    )
  })

  await t.test('updateOne reports matchedCount alongside modifiedCount', async () => {
    const M = model('BulkSqliteOne', new Schema({ employeeId: Number, hits: Number }))
    await M.create({ employeeId: 1, hits: 0 })
    const res = await M.bulkWrite([
      { updateOne: { filter: { employeeId: 1 }, update: { $inc: { hits: 1 } } } }
    ])
    assert.strictEqual(res.matchedCount, 1)
    assert.strictEqual(res.modifiedCount, 1)
  })

  await t.test('deleteOne removes exactly one matching row', async () => {
    const M = model('BulkSqliteDeleteOne', new Schema({ employeeId: Number, tag: String }))
    await M.insertMany([
      { employeeId: 1, tag: 'x' },
      { employeeId: 2, tag: 'x' },
      { employeeId: 3, tag: 'x' },
    ])
    const res = await M.bulkWrite([{ deleteOne: { filter: { tag: 'x' } } }])
    assert.strictEqual(res.deletedCount, 1)
    assert.strictEqual(await M.countDocuments({ tag: 'x' }), 2)
  })

  await t.test('updateMany with upsert still inserts when nothing matches', async () => {
    const M = model('BulkSqliteUpsert', new Schema({ employeeId: Number, labels: [String] }))
    const res = await M.bulkWrite([
      {
        updateMany: {
          filter: { employeeId: 5 },
          update: { $setOnInsert: { employeeId: 5 }, $addToSet: { labels: 'z' } },
          upsert: true
        }
      }
    ])
    assert.strictEqual(res.upsertedCount, 1)
    assert.strictEqual(await M.countDocuments({ employeeId: 5 }), 1)
  })
})
