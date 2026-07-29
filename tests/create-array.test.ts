import { test } from 'node:test'
import assert from 'node:assert'
import { model, Schema, clearRegistry } from '../index'

// Mongoose parity: Model.create() accepts an array of documents.
test('create with an array of documents', async t => {
  t.beforeEach(async () => await clearRegistry())

  await t.test('creates every document and returns them in order', async () => {
    const User = model(
      'CreateArrayUser',
      new Schema({ name: { type: String, required: true }, age: Number })
    )
    const created = await User.create([
      { name: 'Alice', age: 25 },
      { name: 'Bob', age: 32 }
    ])
    assert.strictEqual(created.length, 2)
    assert.strictEqual(created[0].name, 'Alice')
    assert.strictEqual(created[1].name, 'Bob')
    assert.strictEqual(await User.countDocuments({}), 2)
  })

  await t.test('validates each element, not the array itself', async () => {
    const User = model(
      'CreateArrayValidated',
      new Schema({ name: { type: String, required: true } })
    )
    await assert.rejects(
      () => User.create([{ name: 'ok' }, {} as { name: string }]),
      /name is required/
    )
  })

  await t.test('single-document create keeps returning one document', async () => {
    const User = model('CreateSingleUser', new Schema({ name: String }))
    const created = await User.create({ name: 'Solo' })
    assert.ok(!Array.isArray(created))
    assert.strictEqual(created.name, 'Solo')
  })
})
