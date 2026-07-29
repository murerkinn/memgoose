import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry } from '../index'

// MongoDB dotted-path semantics for update operators
// (https://www.mongodb.com/docs/manual/reference/operator/update/set/):
// - a dotted $set merges into the embedded document and creates intermediate
//   documents as needed; setting a top-level field to an object REPLACES the
//   whole embedded document
// - numeric segments index into arrays ('genres.0')
// - the same path resolution applies to $unset/$inc/$push/$addToSet/$setOnInsert
test('Dotted-path update operators', async t => {
  t.beforeEach(async () => await clearRegistry())

  const makeModel = (name: string) =>
    model(name, new Schema({ title: String, imdb: Schema.Types.Mixed, genres: [String] }))

  await t.test('dotted $set merges into the embedded document', async () => {
    const M = makeModel('DotSetMerge')
    await M.create({ title: 'x', imdb: { rating: 9.1, votes: 100 } })
    await M.updateOne({ title: 'x' }, { $set: { 'imdb.highlight': "Critics' Choice" } })
    const doc = await M.findOne({ title: 'x' }).lean()
    assert.deepStrictEqual(doc?.imdb, { rating: 9.1, votes: 100, highlight: "Critics' Choice" })
  })

  await t.test('top-level $set replaces the whole embedded document', async () => {
    const M = makeModel('DotSetReplace')
    await M.create({ title: 'x', imdb: { rating: 9.1, votes: 100 } })
    await M.updateOne({ title: 'x' }, { $set: { imdb: { highlight: 'only this' } } })
    const doc = await M.findOne({ title: 'x' }).lean()
    assert.deepStrictEqual(doc?.imdb, { highlight: 'only this' })
  })

  await t.test('dotted $set creates intermediate documents as needed', async () => {
    const M = makeModel('DotSetCreate')
    await M.create({ title: 'x' })
    await M.updateOne({ title: 'x' }, { $set: { 'imdb.meta.source': 'api' } })
    const doc = await M.findOne({ title: 'x' }).lean()
    assert.deepStrictEqual(doc?.imdb, { meta: { source: 'api' } })
  })

  await t.test('numeric segments index into arrays', async () => {
    const M = makeModel('DotSetArray')
    await M.create({ title: 'x', genres: ['Drama', 'Comedy'] })
    await M.updateOne({ title: 'x' }, { $set: { 'genres.0': 'Thriller' } })
    const doc = await M.findOne({ title: 'x' }).lean()
    assert.deepStrictEqual(doc?.genres, ['Thriller', 'Comedy'])
  })

  await t.test('dotted $unset removes the leaf and keeps siblings', async () => {
    const M = makeModel('DotUnset')
    await M.create({ title: 'x', imdb: { rating: 9.1, votes: 100 } })
    await M.updateOne({ title: 'x' }, { $unset: { 'imdb.votes': 1 } })
    const doc = await M.findOne({ title: 'x' }).lean()
    assert.deepStrictEqual(doc?.imdb, { rating: 9.1 })
  })

  await t.test('dotted $inc creates the path and increments', async () => {
    const M = makeModel('DotInc')
    await M.create({ title: 'x' })
    await M.updateOne({ title: 'x' }, { $inc: { 'imdb.stats.views': 3 } })
    await M.updateOne({ title: 'x' }, { $inc: { 'imdb.stats.views': 2 } })
    const doc = await M.findOne({ title: 'x' }).lean()
    assert.deepStrictEqual(doc?.imdb, { stats: { views: 5 } })
  })

  await t.test('dotted $addToSet and $push create the nested array', async () => {
    const M = makeModel('DotArrayOps')
    await M.create({ title: 'x' })
    await M.updateOne({ title: 'x' }, { $addToSet: { 'imdb.tags': 'a' } })
    await M.updateOne({ title: 'x' }, { $addToSet: { 'imdb.tags': 'a' } })
    await M.updateOne({ title: 'x' }, { $push: { 'imdb.history': 'h1' } })
    const doc = await M.findOne({ title: 'x' }).lean()
    assert.deepStrictEqual(doc?.imdb, { tags: ['a'], history: ['h1'] })
  })

  await t.test('dotted $setOnInsert applies on upsert insert', async () => {
    const M = makeModel('DotSetOnInsert')
    const res = await M.updateOne(
      { title: 'x' },
      { $setOnInsert: { 'imdb.meta.source': 'seed' }, $set: { 'imdb.rating': 8 } },
      { upsert: true }
    )
    assert.strictEqual(res.upsertedCount, 1)
    const doc = await M.findOne({ title: 'x' }).lean()
    assert.deepStrictEqual(doc?.imdb, { meta: { source: 'seed' }, rating: 8 })
  })

  await t.test('rejects prototype-chain path segments (prototype pollution)', async () => {
    const M = makeModel('DotProtoGuard')
    await M.create({ title: 'x' })
    for (const path of ['__proto__.polluted', 'imdb.constructor.prototype.polluted', 'imdb.prototype.polluted']) {
      await assert.rejects(async () => {
        await M.updateOne({ title: 'x' }, { $set: { [path]: true } })
      }, /Unsafe document path/)
    }
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined)
  })

  await t.test('findOneAndUpdate honors dotted paths too', async () => {
    const M = makeModel('DotFoau')
    await M.create({ title: 'x', imdb: { rating: 9.1 } })
    const updated = await M.findOneAndUpdate(
      { title: 'x' },
      { $set: { 'imdb.highlight': 'yes' } },
      { new: true }
    )
    assert.deepStrictEqual(updated?.imdb, { rating: 9.1, highlight: 'yes' })
  })
})
