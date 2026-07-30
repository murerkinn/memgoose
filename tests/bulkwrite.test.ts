import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry, BulkWriteError } from '../index'

// Model.bulkWrite with the mongoose/driver operation shapes and result counts:
// insertOne, updateOne/updateMany (with upsert), deleteOne/deleteMany,
// replaceOne. Ordered by default (stops at the first error); ordered: false
// attempts every operation and reports writeErrors.
test('Model.bulkWrite', async t => {
  t.beforeEach(async () => await clearRegistry())

  const makeModel = (name: string) =>
    model(
      name,
      new Schema({
        employeeId: { type: Number, required: true },
        raw: Schema.Types.Mixed,
        labels: { type: [String], default: [], index: true }
      })
    )

  await t.test('mixes inserts, updates and deletes with driver-shaped counts', async () => {
    const M = makeModel('BulkMixed')
    await M.insertMany([
      { employeeId: 1, labels: ['a'] },
      { employeeId: 2, labels: ['a'] },
      { employeeId: 3, labels: ['b'] }
    ])
    const res = await M.bulkWrite([
      { insertOne: { document: { employeeId: 4, labels: ['c'] } } },
      { updateOne: { filter: { employeeId: 1 }, update: { $addToSet: { labels: 'x' } } } },
      { updateMany: { filter: { labels: 'a' }, update: { $set: { raw: { seen: true } } } } },
      { deleteOne: { filter: { employeeId: 3 } } }
    ])
    assert.strictEqual(res.insertedCount, 1)
    assert.strictEqual(res.matchedCount, 3) // updateOne 1 + updateMany 2
    assert.strictEqual(res.modifiedCount, 3)
    assert.strictEqual(res.deletedCount, 1)
    assert.strictEqual(res.upsertedCount, 0)
    assert.ok(res.insertedIds[0])
    assert.deepStrictEqual((await M.findOne({ employeeId: 1 }).lean())?.labels, ['a', 'x'])
    assert.strictEqual(await M.countDocuments({}), 3)
  })

  await t.test('deleteMany removes every match and counts them', async () => {
    const M = makeModel('BulkDeleteMany')
    await M.insertMany([
      { employeeId: 1, labels: ['x'] },
      { employeeId: 2, labels: ['x'] },
      { employeeId: 3, labels: ['y'] }
    ])
    const res = await M.bulkWrite([{ deleteMany: { filter: { labels: 'x' } } }])
    assert.strictEqual(res.deletedCount, 2)
    assert.strictEqual(await M.countDocuments({}), 1)
  })

  await t.test('upsertedIds stays correct when the update rewrites a filter field', async () => {
    const M = makeModel('BulkUpsertRewrites')
    const res = await M.bulkWrite([
      {
        updateOne: {
          filter: { employeeId: 50, labels: 'pending' },
          update: { $setOnInsert: { employeeId: 50 }, $set: { labels: ['active'] } },
          upsert: true
        }
      }
    ])
    assert.strictEqual(res.upsertedCount, 1)
    const doc = await M.findOne({ employeeId: 50 }).lean()
    assert.strictEqual(String(res.upsertedIds[0]), String(doc?._id))
  })

  await t.test('matched but unmodified updates count matched only', async () => {
    const M = makeModel('BulkNoop')
    await M.create({ employeeId: 60, labels: ['a'] })
    const res = await M.bulkWrite([
      { updateOne: { filter: { employeeId: 60 }, update: { $addToSet: { labels: 'a' } } } }
    ])
    assert.strictEqual(res.matchedCount, 1)
    assert.strictEqual(res.modifiedCount, 0)
  })

  await t.test('updateOne with upsert follows $setOnInsert semantics per operation', async () => {
    const M = makeModel('BulkUpsert')
    const land = (id: number, label: string) => ({
      updateOne: {
        filter: { employeeId: id },
        update: {
          $setOnInsert: { employeeId: id, raw: { id } },
          $addToSet: { labels: label }
        },
        upsert: true
      }
    })
    const first = await M.bulkWrite([land(10, 'cohort-a'), land(11, 'cohort-a')])
    assert.strictEqual(first.upsertedCount, 2)
    assert.strictEqual(Object.keys(first.upsertedIds).length, 2)

    const second = await M.bulkWrite([land(10, 'cohort-b'), land(12, 'cohort-b')])
    assert.strictEqual(second.upsertedCount, 1)
    assert.strictEqual(second.matchedCount, 1)
    assert.strictEqual(second.modifiedCount, 1)
    const doc = await M.findOne({ employeeId: 10 }).lean()
    assert.deepStrictEqual(doc?.raw, { id: 10 })
    assert.deepStrictEqual([...(doc?.labels ?? [])].sort(), ['cohort-a', 'cohort-b'])
  })

  await t.test('updateMany with upsert inserts when nothing matches', async () => {
    const M = makeModel('BulkUpdateManyUpsert')
    const res = await M.bulkWrite([
      {
        updateMany: {
          filter: { employeeId: 99 },
          update: { $setOnInsert: { employeeId: 99 }, $addToSet: { labels: 'z' } },
          upsert: true
        }
      }
    ])
    assert.strictEqual(res.upsertedCount, 1)
    assert.deepStrictEqual((await M.findOne({ employeeId: 99 }).lean())?.labels, ['z'])
  })

  await t.test('replaceOne swaps the whole document, keeping _id', async () => {
    const M = makeModel('BulkReplace')
    await M.create({ employeeId: 5, raw: { old: true }, labels: ['a'] })
    const before = await M.findOne({ employeeId: 5 }).lean()
    const res = await M.bulkWrite([
      { replaceOne: { filter: { employeeId: 5 }, replacement: { employeeId: 5, labels: [] } } }
    ])
    assert.strictEqual(res.matchedCount, 1)
    assert.strictEqual(res.modifiedCount, 1)
    const after = await M.findOne({ employeeId: 5 }).lean()
    assert.strictEqual(String(after?._id), String(before?._id))
    assert.strictEqual(after?.raw, undefined)
  })

  await t.test('replaceOne with upsert inserts when nothing matches', async () => {
    const M = makeModel('BulkReplaceUpsert')
    const res = await M.bulkWrite([
      { replaceOne: { filter: { employeeId: 70 }, replacement: { employeeId: 70 }, upsert: true } }
    ])
    assert.strictEqual(res.upsertedCount, 1)
    assert.ok(res.upsertedIds[0])
    assert.strictEqual(await M.countDocuments({ employeeId: 70 }), 1)
  })

  await t.test('replaceOne rejects a replacement that alters _id', async () => {
    const M = makeModel('BulkReplaceImmutableId')
    await M.create({ employeeId: 80 })
    await assert.rejects(
      async () => {
        await M.bulkWrite([
          {
            replaceOne: {
              filter: { employeeId: 80 },
              replacement: { _id: 'someone-else', employeeId: 80 } as never
            }
          }
        ])
      },
      (err: unknown) => {
        assert.ok(err instanceof BulkWriteError)
        assert.match(err.writeErrors[0].error.message, /immutable.*_id/)
        return true
      }
    )
  })

  await t.test('replaceOne rejects prototype-chain replacement keys', async () => {
    const M = makeModel('BulkReplaceProto')
    await M.create({ employeeId: 90 })
    const replacement = JSON.parse('{"employeeId": 90, "__proto__": {"polluted": true}}')
    await assert.rejects(
      async () => {
        await M.bulkWrite([{ replaceOne: { filter: { employeeId: 90 }, replacement } }])
      },
      (err: unknown) => {
        assert.ok(err instanceof BulkWriteError)
        assert.match(err.writeErrors[0].error.message, /Unsafe replacement key/)
        return true
      }
    )
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined)
  })

  await t.test('replaceOne keeps the discriminator key on discriminator models', async () => {
    const Base = model('BulkReplaceBase', new Schema({ kind: String, name: String }))
    const Dog = Base.discriminator('BulkReplaceDog', new Schema({ barks: Boolean }))
    await Dog.create({ name: 'rex', barks: true })
    await Dog.bulkWrite([
      { replaceOne: { filter: { name: 'rex' }, replacement: { name: 'rex', barks: false } } },
    ])
    const doc = await Dog.findOne({ name: 'rex' }).lean()
    assert.ok(doc, 'document must still match its discriminator model')
    assert.strictEqual(doc?.barks, false)
  })

  await t.test('rejects an empty batch', async () => {
    const M = makeModel('BulkEmpty')
    await assert.rejects(async () => {
      await M.bulkWrite([])
    }, /Batch cannot be empty/)
  })

  await t.test('ordered run stops at the first failing operation', async () => {
    const M = makeModel('BulkOrdered')
    await assert.rejects(async () => {
      await M.bulkWrite([
        { insertOne: { document: { employeeId: 20 } } },
        { insertOne: { document: { raw: { missingRequired: true } } } }, // employeeId required
        { insertOne: { document: { employeeId: 21 } } }
      ])
    })
    assert.strictEqual(await M.countDocuments({}), 1) // stopped after the failure
  })

  await t.test('unordered run attempts everything and reports writeErrors', async () => {
    const M = makeModel('BulkUnordered')
    await assert.rejects(
      async () => {
        await M.bulkWrite(
          [
            { insertOne: { document: { employeeId: 30 } } },
            { insertOne: { document: { raw: { bad: true } } } },
            { insertOne: { document: { employeeId: 31 } } }
          ],
          { ordered: false }
        )
      },
      (err: unknown) => {
        assert.ok(err instanceof BulkWriteError)
        assert.strictEqual(err.writeErrors.length, 1)
        assert.strictEqual(err.writeErrors[0].index, 1)
        assert.strictEqual(err.result.insertedCount, 2) // partial counts survive on the error
        return true
      }
    )
    assert.strictEqual(await M.countDocuments({}), 2) // both valid inserts landed
  })

  await t.test('rejects unknown operation names', async () => {
    const M = makeModel('BulkUnknownOp')
    await assert.rejects(async () => {
      await M.bulkWrite([{ frobnicate: { filter: {} } } as never])
    }, /unknown bulkWrite operation/i)
    await assert.rejects(async () => {
      await M.bulkWrite([
        { insertOne: { document: { employeeId: 1 } }, deleteMany: { filter: {} } } as never
      ])
    }, /unknown bulkWrite operation/i)
    assert.strictEqual(await M.countDocuments({}), 0) // parse-stage failure writes nothing
  })
})
