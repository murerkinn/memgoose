import { test } from 'node:test'
import assert from 'node:assert'
import { connect, model, Schema, disconnect } from '../index'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DATA_PATH = './test-sqlite-regex-in-data'

async function cleanupTestData() {
  if (fs.existsSync(TEST_DATA_PATH)) {
    const files = fs.readdirSync(TEST_DATA_PATH)
    for (const file of files) {
      fs.unlinkSync(path.join(TEST_DATA_PATH, file))
    }
    fs.rmdirSync(TEST_DATA_PATH)
  }
}

// The SQLite strategy translates queries to SQL natively, so regex members in
// $in/$nin/$all and bare-regex equality need their own translation instead of
// being bound as (unbindable) RegExp parameters.
test('Regex members on SQLite storage', async t => {
  t.beforeEach(async () => {
    await cleanupTestData()
    connect({ storage: 'sqlite', sqlite: { dataPath: TEST_DATA_PATH } })
  })

  t.afterEach(async () => {
    await disconnect()
    await cleanupTestData()
  })

  const seed = async (name: string) => {
    const M = model(name, new Schema({ employeeId: Number, name: String, skills: [String] }))
    await M.insertMany([
      { employeeId: 1, name: 'Python Developer', skills: ['Python', 'Leadership'] },
      { employeeId: 2, name: 'Java Engineer', skills: ['java'] },
      { employeeId: 3, name: 'Designer', skills: ['Design'] }
    ])
    return M
  }

  await t.test('$in with regex members matches scalar strings', async () => {
    const M = await seed('SqliteRegexScalar')
    const rows = await M.find({ name: { $in: [/python/i, /java/i] } }).sort({ employeeId: 1 })
    assert.deepStrictEqual(
      rows.map(r => r.employeeId),
      [1, 2]
    )
  })

  await t.test('$in with regex members matches array elements case-insensitively', async () => {
    const M = await seed('SqliteRegexArray')
    assert.strictEqual(await M.countDocuments({ skills: { $in: [/^java$/i] } }), 1)
    assert.strictEqual(await M.countDocuments({ skills: { $in: [/^python$/i, /^design$/i] } }), 2)
  })

  await t.test('$in mixes regex and plain members', async () => {
    const M = await seed('SqliteRegexMixed')
    const rows = await M.find({ name: { $in: [/^des/i, 'Java Engineer'] } }).sort({
      employeeId: 1
    })
    assert.deepStrictEqual(
      rows.map(r => r.employeeId),
      [2, 3]
    )
  })

  await t.test('$nin with regex members excludes matches and keeps missing fields', async () => {
    const M = await seed('SqliteRegexNin')
    await M.create({ employeeId: 4 })
    const rows = await M.find({ name: { $nin: [/python/i, /java/i] } }).sort({ employeeId: 1 })
    assert.deepStrictEqual(
      rows.map(r => r.employeeId),
      [3, 4]
    )
  })

  await t.test('bare regex equality works natively', async () => {
    const M = await seed('SqliteRegexBare')
    assert.strictEqual(await M.countDocuments({ name: /engineer$/i }), 1)
    assert.strictEqual(await M.countDocuments({ skills: /^leadership$/i }), 1)
  })

  await t.test('$all accepts regex members', async () => {
    const M = await seed('SqliteRegexAll')
    const rows = await M.find({ skills: { $all: [/^python$/i, 'Leadership'] } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 1)
  })
})
