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
})
