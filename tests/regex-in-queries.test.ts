import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry, ObjectId } from '../index'

// MongoDB $in/$nin semantics: array members may be regular expressions, which
// match string values (and string elements of array fields) as regex tests,
// alongside plain members which keep equality semantics.
test('Regex members in $in and $nin', async t => {
  t.beforeEach(async () => await clearRegistry())

  const makeModel = (name: string) =>
    model(name, new Schema({ employeeId: Number, name: String, skills: [String] }))

  await t.test('$in with regex members matches scalar string fields', async () => {
    const M = makeModel('RegexInScalar')
    await M.insertMany([
      { employeeId: 1, name: 'Python Developer' },
      { employeeId: 2, name: 'Java Engineer' },
      { employeeId: 3, name: 'Designer' }
    ])
    const rows = await M.find({ name: { $in: [/python/i, /java/i] } }).sort({ employeeId: 1 })
    assert.deepStrictEqual(
      rows.map(r => r.employeeId),
      [1, 2]
    )
  })

  await t.test('$in with regex members matches elements of array fields', async () => {
    const M = makeModel('RegexInArray')
    await M.insertMany([
      { employeeId: 1, skills: ['Python', 'Leadership'] },
      { employeeId: 2, skills: ['python'] },
      { employeeId: 3, skills: ['Java'] },
      { employeeId: 4, skills: [] }
    ])
    assert.strictEqual(await M.countDocuments({ skills: { $in: [/^python$/i] } }), 2)
    assert.strictEqual(await M.countDocuments({ skills: { $in: [/^python$/i, /^java$/i] } }), 3)
    assert.strictEqual(await M.countDocuments({ skills: { $in: [/^nothing$/i] } }), 0)
  })

  await t.test('$in mixes regex and plain members', async () => {
    const M = makeModel('RegexInMixed')
    await M.insertMany([
      { employeeId: 1, skills: ['Python'] },
      { employeeId: 2, skills: ['Go'] },
      { employeeId: 3, skills: ['Rust'] }
    ])
    const rows = await M.find({ skills: { $in: [/^py/i, 'Go'] } }).sort({ employeeId: 1 })
    assert.deepStrictEqual(
      rows.map(r => r.employeeId),
      [1, 2]
    )
  })

  await t.test('a regex member never matches non-string values', async () => {
    const M = model('RegexInNonString', new Schema({ employeeId: Number, code: Object }))
    await M.insertMany([
      { employeeId: 1, code: 42 },
      { employeeId: 2, code: '42' }
    ])
    const rows = await M.find({ code: { $in: [/42/] } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 2)
  })

  await t.test('$nin with regex members excludes matching documents', async () => {
    const M = makeModel('RegexNin')
    await M.insertMany([
      { employeeId: 1, skills: ['Python'] },
      { employeeId: 2, skills: ['Java'] },
      { employeeId: 3, skills: ['Design'] }
    ])
    const rows = await M.find({ skills: { $nin: [/^python$/i, /^java$/i] } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 3)
  })

  await t.test('$in with null member still matches missing fields', async () => {
    const M = makeModel('RegexInNull')
    await M.insertMany([{ employeeId: 1 }, { employeeId: 2, name: 'x' }])
    const rows = await M.find({ name: { $in: [null, /^y/] } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 1)
  })

  await t.test('countDocuments honors regex members inside aggregation-free counts', async () => {
    const M = makeModel('RegexInCount')
    await M.insertMany([
      { employeeId: 1, skills: ['TypeScript'] },
      { employeeId: 2, skills: ['JavaScript'] },
      { employeeId: 3, skills: ['Python'] }
    ])
    assert.strictEqual(await M.countDocuments({ skills: { $in: [/script$/i] } }), 2)
  })

  await t.test('a shared g-flagged member matches statelessly across documents', async () => {
    const M = makeModel('RegexInGlobal')
    await M.insertMany([
      { employeeId: 1, name: 'foo' },
      { employeeId: 2, name: 'bob' },
      { employeeId: 3, name: 'box' }
    ])
    const member = /o/g
    const first = await M.countDocuments({ name: { $in: [member] } })
    const second = await M.countDocuments({ name: { $in: [member] } })
    assert.strictEqual(first, 3)
    assert.strictEqual(second, 3)
  })

  await t.test('ObjectId members match by value, not reference', async () => {
    const M = makeModel('RegexInObjectId')
    const created = await M.create({ employeeId: 1, name: 'x' })
    const sameIdNewInstance = new ObjectId(String(created._id))
    const rows = await M.find({ _id: { $in: [sameIdNewInstance] } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 1)
  })

  await t.test('bare regex equality matches strings and array elements', async () => {
    const M = makeModel('RegexBare')
    await M.insertMany([
      { employeeId: 1, name: 'Python Developer', skills: ['Go'] },
      { employeeId: 2, name: 'Designer', skills: ['Python'] },
      { employeeId: 3, name: 'Manager', skills: ['Java'] }
    ])
    assert.strictEqual(await M.countDocuments({ name: /python/i }), 1)
    assert.strictEqual(await M.countDocuments({ skills: /^python$/i }), 1)
    assert.strictEqual(await M.countDocuments({ name: /nobody/ }), 0)
  })

  await t.test('$not with $in mirrors $nin for regex members', async () => {
    const M = makeModel('RegexNotIn')
    await M.insertMany([
      { employeeId: 1, name: 'Python Developer' },
      { employeeId: 2, name: 'Designer' }
    ])
    const rows = await M.find({ name: { $not: { $in: [/python/i] } } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 2)
  })

  await t.test('$all accepts regex members', async () => {
    const M = makeModel('RegexAll')
    await M.insertMany([
      { employeeId: 1, skills: ['TypeScript', 'Python'] },
      { employeeId: 2, skills: ['Python'] }
    ])
    const rows = await M.find({ skills: { $all: [/^type/i, 'Python'] } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 1)
  })

  await t.test('a regex member equals an identical stored regex value', async () => {
    const M = model('RegexStored', new Schema({ employeeId: Number, matcher: Object }))
    await M.insertMany([
      { employeeId: 1, matcher: /^be/ },
      { employeeId: 2, matcher: /^af/ }
    ])
    const rows = await M.find({ matcher: { $in: [/^be/] } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].employeeId, 1)
  })
})
