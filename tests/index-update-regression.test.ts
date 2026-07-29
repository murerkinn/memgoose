import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry } from '../index'

// Regression: updating an indexed document must not leave a stale entry in the
// index bucket. The model layer passes a pre-update snapshot (a spread clone)
// as oldDoc to updateIndexForDocument; removal by indexOf(oldDoc) then misses
// the live reference stored in the bucket, and the subsequent push duplicates
// it — indexed queries (find/count by indexed fields) start returning phantoms.
test('Index maintenance on update', async t => {
  t.beforeEach(async () => await clearRegistry())

  await t.test('findOneAndUpdate with $set keeps a single compound-index entry', async () => {
    const schema = new Schema({
      spec: { type: String, required: true },
      cohort: { type: String, required: true },
      data: [Schema.Types.Mixed]
    })
    schema.index({ spec: 1, cohort: 1 }, { unique: true })
    const Snapshot = model('Snapshot', schema)

    const key = { spec: 'industries', cohort: 'c1' }
    await Snapshot.findOneAndUpdate(key, { ...key, data: [1] }, { upsert: true })
    await Snapshot.findOneAndUpdate(key, { $set: { data: [2] } }, { upsert: true })

    assert.strictEqual(await Snapshot.countDocuments(key), 1)
    assert.strictEqual((await Snapshot.find(key)).length, 1)
    const all = await Snapshot.find({})
    assert.strictEqual(all.length, 1)
    assert.deepStrictEqual(all[0].data, [2])
  })

  await t.test('updateOne on an indexed field keeps a single index entry', async () => {
    const schema = new Schema({
      email: { type: String, unique: true },
      visits: Number
    })
    const User = model('IndexedUser', schema)

    await User.create({ email: 'a@b.co', visits: 1 })
    await User.updateOne({ email: 'a@b.co' }, { $set: { visits: 2 } })

    assert.strictEqual(await User.countDocuments({ email: 'a@b.co' }), 1)
    assert.strictEqual((await User.find({ email: 'a@b.co' })).length, 1)
  })

  await t.test('update that changes the indexed value moves the entry, not copies it', async () => {
    const schema = new Schema({
      email: { type: String, unique: true },
      visits: Number
    })
    const User = model('MovedIndexUser', schema)

    await User.create({ email: 'a@b.co', visits: 1 })
    await User.updateOne({ email: 'a@b.co' }, { $set: { email: 'c@d.co' } })

    assert.strictEqual(await User.countDocuments({ email: 'a@b.co' }), 0)
    assert.strictEqual(await User.countDocuments({ email: 'c@d.co' }), 1)
    assert.strictEqual((await User.find({})).length, 1)
  })
})
