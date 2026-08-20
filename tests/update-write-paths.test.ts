import { test } from 'node:test'
import assert from 'node:assert'
import { createDatabase, Schema } from '../index'
import type { Update } from '../index'
import * as fs from 'fs'

// The write paths only differ once storage stops handing back the stored object
// itself. Memory storage returns the live reference and file storage keeps the
// documents in an in-memory array it later compacts to disk, so an update applied
// in place but never persisted still reads back correctly on both. SQLite parses a
// fresh object per read, which is the only place these regressions are visible —
// so this suite runs there, and re-reads through a reopened database as well.

interface Doc {
  name: string
  age: number
  tags?: string[]
  profile?: { city?: string; zip?: string }
  createdAt?: Date | string
  updatedAt?: Date | string
}

const docSchema = () =>
  new Schema<Doc>({ name: String, age: Number, tags: Array, profile: Object }, { timestamps: true })

const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true })

const stamp = (value: Date | string | undefined): string => new Date(value as string).toISOString()

test('SQLite storage write paths', async t => {
  const dataPath = './test-sqlite-update-paths'
  const db = () => createDatabase({ storage: 'sqlite', sqlite: { dataPath } })

  let database: ReturnType<typeof createDatabase>
  t.beforeEach(() => {
    cleanup(dataPath)
    database = db()
  })
  t.afterEach(async () => {
    await database.disconnect()
    cleanup(dataPath)
  })

  await t.test('findOneAndUpdate persists the update', async () => {
    const M = database.model<Doc>('FoauPersist', docSchema())
    await M.create({ name: 'Alice', age: 25 })

    const returned = await M.findOneAndUpdate(
      { name: 'Alice' },
      { $set: { age: 99 } },
      { new: true }
    )
    assert.strictEqual(returned?.age, 99)

    // Fresh read of the row, not the object findOneAndUpdate mutated
    const reread = await M.findOne({ name: 'Alice' })
    assert.strictEqual(reread?.age, 99)
  })

  await t.test('findOneAndUpdate persists the update under returnDocument: before', async () => {
    const M = database.model<Doc>('FoauBefore', docSchema())
    await M.create({ name: 'Alice', age: 25 })

    const returned = await M.findOneAndUpdate(
      { name: 'Alice' },
      { $set: { age: 99 } },
      { returnDocument: 'before' }
    )
    assert.strictEqual(returned?.age, 25, 'must return the pre-update document')

    const reread = await M.findOne({ name: 'Alice' })
    assert.strictEqual(reread?.age, 99, 'the update still has to be written')
  })

  await t.test('findOneAndUpdate survives a reconnect', async () => {
    const M = database.model<Doc>('FoauReconnect', docSchema())
    await M.create({ name: 'Alice', age: 25 })
    await M.findOneAndUpdate({ name: 'Alice' }, { $set: { age: 99 } })
    await database.disconnect()

    database = db()
    const reconnected = database.model<Doc>('FoauReconnect', docSchema())
    const reread = await reconnected.findOne({ name: 'Alice' })
    assert.strictEqual(reread?.age, 99)
  })

  await t.test('findOneAndUpdate maintains timestamps', async () => {
    const M = database.model<Doc>('FoauStamp', docSchema())
    const created = await M.create({ name: 'Alice', age: 25 })
    const before = stamp(created.updatedAt)
    await new Promise(resolve => setTimeout(resolve, 5))

    await M.findOneAndUpdate({ name: 'Alice' }, { $set: { age: 26 } })

    const reread = await M.findOne({ name: 'Alice' })
    assert.notStrictEqual(stamp(reread?.updatedAt), before)
    assert.strictEqual(stamp(reread?.createdAt), stamp(created.createdAt))
  })

  await t.test('findOneAndUpdate upsert applies $setOnInsert', async () => {
    const M = database.model<Doc>('FoauUpsert', docSchema())

    const created = await M.findOneAndUpdate(
      { name: 'Nobody' },
      { $set: { age: 5 }, $setOnInsert: { tags: ['seed'] } },
      { upsert: true, new: true }
    )
    assert.strictEqual(created?.age, 5)
    assert.deepStrictEqual(created?.tags, ['seed'])

    const reread = await M.findOne({ name: 'Nobody' })
    assert.deepStrictEqual(reread?.tags, ['seed'])
  })

  await t.test(
    'findOneAndUpdate stamps a no-op update but writes nothing without timestamps',
    async () => {
      // mongoose folds updatedAt into the update itself, so an update that modifies
      // nothing still bumps it — and that bump has to reach storage
      const stamped = database.model<Doc>('FoauNoopStamped', docSchema())
      const created = await stamped.create({ name: 'A', age: 1 })
      await new Promise(resolve => setTimeout(resolve, 5))

      await stamped.findOneAndUpdate({ name: 'A' }, { $setOnInsert: { age: 99 } })
      const reread = await stamped.findOne({ name: 'A' })
      assert.strictEqual(reread?.age, 1, '$setOnInsert is ignored on an existing document')
      assert.notStrictEqual(stamp(reread?.updatedAt), stamp(created.updatedAt))

      // With nothing to stamp either, the document is untouched and needs no write —
      // findOneAndUpdate with only $setOnInsert is the get-or-create idiom
      const plain = database.model<Doc>(
        'FoauNoopPlain',
        new Schema<Doc>({ name: String, age: Number })
      )
      await plain.create({ name: 'A', age: 1 })

      const storage = (
        plain as unknown as { _storage: { update: (a: Doc, b: Doc) => Promise<void> } }
      )._storage
      const write = storage.update.bind(storage)
      let writes = 0
      storage.update = (a, b) => {
        writes++
        return write(a, b)
      }

      await plain.findOneAndUpdate({ name: 'A' }, { $setOnInsert: { age: 99 } })
      assert.strictEqual(writes, 0, 'an unchanged document should not be rewritten')

      await plain.findOneAndUpdate({ name: 'A' }, { $set: { age: 2 } })
      assert.strictEqual(writes, 1, 'a real change still writes')
      assert.strictEqual((await plain.findOne({ name: 'A' }))?.age, 2)
    }
  )

  await t.test('updateOne maintains timestamps', async () => {
    const M = database.model<Doc>('UpdateOneStamp', docSchema())
    const created = await M.create({ name: 'Alice', age: 25 })
    const before = stamp(created.updatedAt)
    await new Promise(resolve => setTimeout(resolve, 5))

    await M.updateOne({ name: 'Alice' }, { $set: { age: 26 } })

    const reread = await M.findOne({ name: 'Alice' })
    assert.strictEqual(reread?.age, 26)
    assert.notStrictEqual(stamp(reread?.updatedAt), before)
    assert.strictEqual(stamp(reread?.createdAt), stamp(created.createdAt))
  })

  await t.test('updateOne modifies exactly one matching document', async () => {
    const M = database.model<Doc>('UpdateOneCount', docSchema())
    await M.insertMany([
      { name: 'Dup', age: 1 },
      { name: 'Dup', age: 1 },
      { name: 'Dup', age: 1 }
    ])

    const result = await M.updateOne({ name: 'Dup' }, { $set: { age: 500 } })
    assert.strictEqual(result.modifiedCount, 1)

    const docs = await M.find({ name: 'Dup' })
    assert.strictEqual(docs.filter(d => d.age === 500).length, 1)
    assert.strictEqual(docs.filter(d => d.age === 1).length, 2)
  })

  await t.test('updateMany maintains timestamps', async () => {
    const M = database.model<Doc>('UpdateManyStamp', docSchema())
    await M.insertMany([
      { name: 'A', age: 1 },
      { name: 'B', age: 1 }
    ])
    const before = (await M.find({})).map(d => stamp(d.updatedAt))
    await new Promise(resolve => setTimeout(resolve, 5))

    const result = await M.updateMany({ age: 1 }, { $set: { age: 2 } })
    assert.strictEqual(result.modifiedCount, 2)

    const docs = await M.find({})
    assert.deepStrictEqual(
      docs.map(d => d.age),
      [2, 2]
    )
    for (const doc of docs) {
      assert.ok(!before.includes(stamp(doc.updatedAt)), 'updatedAt should be bumped')
    }
  })

  await t.test('updateMany with a direct field update maintains timestamps', async () => {
    const M = database.model<Doc>('UpdateManyDirect', docSchema())
    const created = await M.create({ name: 'A', age: 1 })
    const before = stamp(created.updatedAt)
    await new Promise(resolve => setTimeout(resolve, 5))

    await M.updateMany({ name: 'A' }, { age: 7 })

    const reread = await M.findOne({ name: 'A' })
    assert.strictEqual(reread?.age, 7)
    assert.notStrictEqual(stamp(reread?.updatedAt), before)
  })

  await t.test('an update touching updatedAt itself still gets stamped', async () => {
    const M = database.model<Doc>('UpdateStampCollision', docSchema())
    await M.create({ name: 'A', age: 1, tags: ['keep'] })

    // The stamp is applied after the caller's update on the JavaScript path, so
    // unsetting updatedAt cannot leave the document without one
    await M.updateMany({ name: 'A' }, {
      $unset: { updatedAt: '', tags: '' }
    } as unknown as Update<Doc>)
    const unset = await M.findOne({ name: 'A' })
    assert.ok(unset?.updatedAt, 'updatedAt must survive being unset')
    assert.ok(!Number.isNaN(new Date(unset?.updatedAt as string).getTime()))
    assert.strictEqual(unset?.tags, undefined, 'the other unset field still applies')

    // Same for a numeric operator aimed at the timestamp
    await M.updateMany({ name: 'A' }, { $inc: { updatedAt: 1, age: 5 } } as unknown as Update<Doc>)
    const inc = await M.findOne({ name: 'A' })
    assert.strictEqual(inc?.age, 6)
    assert.ok(!Number.isNaN(new Date(inc?.updatedAt as string).getTime()), 'still a timestamp')

    await M.updateMany({ name: 'A' }, { $dec: { updatedAt: 1 } } as unknown as Update<Doc>)
    const dec = await M.findOne({ name: 'A' })
    assert.ok(!Number.isNaN(new Date(dec?.updatedAt as string).getTime()), 'still a timestamp')
  })

  await t.test('operators the SQL builder cannot express still apply', async () => {
    const M = database.model<Doc>('UpdateOps', docSchema())
    await M.create({ name: 'A', age: 1, tags: ['x', 'y'], profile: { city: 'ist' } })

    // $pull and $addToSet have no SQL translation, and a dotted $set cannot
    // create intermediate objects with json_set — all three must fall back to
    // the JavaScript path rather than report a modification and change nothing
    await M.updateOne({ name: 'A' }, { $pull: { tags: 'x' } })
    assert.deepStrictEqual((await M.findOne({ name: 'A' }))?.tags, ['y'])

    await M.updateMany({ name: 'A' }, { $addToSet: { tags: 'z' } })
    assert.deepStrictEqual((await M.findOne({ name: 'A' }))?.tags, ['y', 'z'])

    await M.updateMany({ name: 'A' }, { $set: { 'profile.zip': '06' } } as unknown as Update<Doc>)
    assert.deepStrictEqual((await M.findOne({ name: 'A' }))?.profile, { city: 'ist', zip: '06' })
  })

  await t.test('updateMany enforces schema constraints', async () => {
    // A constrained schema cannot take the native path, which writes without ever
    // materialising a document to validate
    const constrained = new Schema<Doc>({
      name: { type: String, required: true },
      age: { type: Number, min: 0 },
      tags: Array
    })
    const M = database.model<Doc>('UpdateValidate', constrained)
    await M.insertMany([
      { name: 'A', age: 5 },
      { name: 'B', age: 5 }
    ])

    await assert.rejects(async () => {
      await M.updateMany({ name: 'A' }, { $set: { age: -5 } })
    }, /age must be at least 0/)
    await assert.rejects(async () => {
      await M.updateMany({ name: 'B' }, { $unset: { name: '' } } as unknown as Update<Doc>)
    }, /name is required/)

    // Nothing is written when validation fails, for any matched document
    const docs = await M.find({})
    assert.deepStrictEqual(docs.map(d => `${d.name}:${d.age}`).sort(), ['A:5', 'B:5'])

    // A valid update still applies
    await M.updateMany({}, { $set: { age: 7 } })
    assert.deepStrictEqual(
      (await M.find({})).map(d => d.age),
      [7, 7]
    )
  })

  await t.test('updateMany enforces unique indexes', async () => {
    const unique = new Schema<Doc>({ name: { type: String, unique: true }, age: Number })
    const M = database.model<Doc>('UpdateUnique', unique)
    await M.insertMany([
      { name: 'A', age: 1 },
      { name: 'B', age: 2 }
    ])

    await assert.rejects(async () => {
      await M.updateMany({ age: 1 }, { $set: { name: 'B' } })
    }, /duplicate key/)
    assert.deepStrictEqual((await M.find({})).map(d => d.name).sort(), ['A', 'B'])
  })

  await t.test('an update with no effect reports no modification', async () => {
    const M = database.model<Doc>('UpdateNoop', docSchema())
    await M.create({ name: 'A', age: 1 })

    // $mul is not implemented on any path; it must not claim to have written
    const result = await M.updateOne({ name: 'A' }, { $mul: { age: 3 } } as unknown as Update<Doc>)
    assert.strictEqual(result.modifiedCount, 0)
    assert.strictEqual((await M.findOne({ name: 'A' }))?.age, 1)
  })
})
