import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry } from '../index'

// $addFields path refs, $let variable scoping, dotted $$var paths (with array
// projection) and comparison operators inside $filter/$cond — the building
// blocks of expressions like "first active experience entry carrying a field".
test('Aggregation $let, variables and comparison expressions', async t => {
  t.beforeEach(async () => await clearRegistry())

  const seed = async () => {
    const M = model(
      'LetDocs',
      new Schema({ n: Number, raw: Schema.Types.Mixed, labels: [String] })
    )
    await M.insertMany([
      {
        n: 1,
        labels: ['l'],
        raw: {
          experience: [
            { company_id: 7, company_name: 'Google' },
            { company_id: 9, company_name: 'Old Co', date_to: '2019-01-01' }
          ]
        }
      },
      {
        n: 2,
        labels: ['l'],
        raw: { experience: [{ company_id: 7, company_name: 'Google LLC' }] }
      },
      { n: 3, labels: ['l'], raw: { experience: [{ company_name: 'Freelance' }] } }
    ])
    return M
  }

  await t.test('$addFields resolves string path references', async () => {
    const M = await seed()
    const rows = await M.aggregate([{ $addFields: { copy: '$n' } }, { $project: { copy: 1, _id: 0 } }])
    assert.deepStrictEqual(
      rows.map(r => r.copy),
      [1, 2, 3]
    )
  })

  await t.test('$filter applies comparison conditions on $$this', async () => {
    const M = await seed()
    const rows = await M.aggregate([
      { $match: { n: 1 } },
      {
        $addFields: {
          active: {
            $filter: {
              input: { $ifNull: ['$raw.experience', []] },
              cond: { $eq: [{ $ifNull: ['$$this.date_to', null] }, null] }
            }
          }
        }
      },
      { $project: { _id: 0, count: { $size: '$active' } } }
    ])
    assert.strictEqual(rows[0].count, 1)
  })

  await t.test('$let binds vars and dotted $$var paths project across arrays', async () => {
    const M = await seed()
    const activeExpField = (field: string) => ({
      $let: {
        vars: {
          active: {
            $filter: {
              input: { $ifNull: ['$raw.experience', []] },
              cond: {
                $and: [
                  { $eq: [{ $ifNull: ['$$this.date_to', null] }, null] },
                  { $ne: [{ $ifNull: [`$$this.${field}`, null] }, null] }
                ]
              }
            }
          }
        },
        in: { $arrayElemAt: [`$$active.${field}`, 0] }
      }
    })
    const rows = await M.aggregate([
      { $addFields: { companyId: activeExpField('company_id'), companyName: activeExpField('company_name') } },
      { $project: { _id: 0, n: 1, companyId: 1, companyName: 1 } }
    ])
    // freelancer: $arrayElemAt over the empty filtered array yields "missing",
    // so $addFields does not create companyId at all (MongoDB semantics)
    assert.deepStrictEqual(rows, [
      { n: 1, companyId: 7, companyName: 'Google' },
      { n: 2, companyId: 7, companyName: 'Google LLC' },
      { n: 3, companyName: 'Freelance' }
    ])
  })

  await t.test('two-pass canonical grouping with $first over sorted groups', async () => {
    const M = await seed()
    const activeExpField = (field: string) => ({
      $let: {
        vars: {
          active: {
            $filter: {
              input: { $ifNull: ['$raw.experience', []] },
              cond: {
                $and: [
                  { $eq: [{ $ifNull: ['$$this.date_to', null] }, null] },
                  { $ne: [{ $ifNull: [`$$this.${field}`, null] }, null] }
                ]
              }
            }
          }
        },
        in: { $arrayElemAt: [`$$active.${field}`, 0] }
      }
    })
    const rows = await M.aggregate([
      { $match: { labels: 'l' } },
      { $addFields: { cid: activeExpField('company_id'), cname: activeExpField('company_name') } },
      { $match: { cid: { $ne: null }, cname: { $ne: null } } },
      { $group: { _id: { id: '$cid', name: '$cname' }, c: { $sum: 1 } } },
      { $sort: { c: -1, '_id.name': 1 } },
      { $group: { _id: '$_id.id', label: { $first: '$_id.name' }, value: { $sum: '$c' } } },
      { $project: { _id: 0, label: 1, value: 1 } }
    ])
    assert.deepStrictEqual(rows, [{ label: 'Google', value: 2 }])
  })

  await t.test('dotted $project inclusion rebuilds the nested shape', async () => {
    const M = model(
      'DottedProjection',
      new Schema({ name: String, size: Schema.Types.Mixed })
    )
    await M.insertMany([
      { name: 'a', size: { uom: 'cm', h: 10 } },
      { name: 'b', size: { h: 5 } }
    ])
    const rows = await M.aggregate([{ $project: { _id: 0, 'size.uom': 1 } }])
    assert.deepStrictEqual(rows, [{ size: { uom: 'cm' } }, {}])
  })

  await t.test('malformed $eq/$ne operands fall through instead of throwing', async () => {
    const M = model('MalformedEq', new Schema({ n: Number }))
    await M.create({ n: 1 })
    const rows = await M.aggregate([{ $project: { _id: 0, x: { $eq: 'not-an-array' } } }])
    assert.strictEqual(rows.length, 1)
  })

  await t.test('null operands are not numerically comparable', async () => {
    const M = model('NullCompare', new Schema({ n: Schema.Types.Mixed }))
    await M.insertMany([{ n: null }, { n: 1 }])
    const rows = await M.aggregate([
      { $project: { _id: 0, positive: { $gt: ['$n', 0] } } }
    ])
    assert.deepStrictEqual(
      rows.map(r => r.positive),
      [false, true]
    )
  })

  await t.test('$switch and $cond accept comparison expressions', async () => {
    const M = await seed()
    const rows = await M.aggregate([
      {
        $project: {
          _id: 0,
          sizeClass: {
            $switch: {
              branches: [
                { case: { $gte: ['$n', 3] }, then: 'big' },
                { case: { $gte: ['$n', 2] }, then: 'mid' }
              ],
              default: 'small'
            }
          }
        }
      }
    ])
    assert.deepStrictEqual(
      rows.map(r => r.sizeClass),
      ['small', 'mid', 'big']
    )
  })
})
