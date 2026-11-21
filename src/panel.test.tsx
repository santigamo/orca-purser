// The panel against a stand-in worker.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { PurserState } from './protocol'

const empty: PurserState = {
  protection: 'os-keyring',
  secrets: [],
  asks: [],
  serving: true
}

const row = (name: string) => ({ name, createdAt: 1, updatedAt: 1, lastUsedAt: null, short: false })

test('adds a secret under the name tools expect and clears the value field', async () => {
  const saved: { name: string; value: string }[] = []
  let current = empty
  const host = mockHost({
    requests: {
      'state.get': () => current,
      'secret.save': (input: { name: string; value: string }) => {
        saved.push(input)
        current = { ...current, secrets: [row(input.name)] }
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  assert.match(view.summary().join('\n'), /No secrets yet/)
  assert.equal(view.find({ label: 'Name' }), null, 'the form stays hidden until asked for')

  await view.press({ label: 'Add a secret' })
  await view.type({ label: 'Name' }, 'stripe api key')
  assert.ok(view.find({ text: 'Saved as STRIPE_API_KEY' }))
  await view.type({ label: 'Value' }, 'sk_test_123456', { submit: true })

  assert.deepEqual(saved, [{ name: 'STRIPE_API_KEY', value: 'sk_test_123456' }])
  assert.equal(view.find({ label: 'Value' }), null, 'the form closes after saving')
  assert.ok(view.find({ text: 'STRIPE_API_KEY' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows a waiting agent first and answers it', async () => {
  const saved: { name: string; value: string }[] = []
  let current: PurserState = {
    ...empty,
    asks: [{ id: 'a1', name: 'OPENAI_API_KEY', reason: 'to run the evals', from: 'Codex in api', at: Date.now() }]
  }
  const host = mockHost({
    requests: {
      'state.get': () => current,
      'secret.save': (input: { name: string; value: string }) => {
        saved.push(input)
        current = { ...current, asks: [], secrets: [row(input.name)] }
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Codex in api is waiting for' }))
  assert.ok(view.find({ text: 'to run the evals' }))
  await view.type({ label: 'Value for OPENAI_API_KEY' }, 'sk-proj-abcdef')
  await view.press({ text: 'Save' })
  assert.deepEqual(saved, [{ name: 'OPENAI_API_KEY', value: 'sk-proj-abcdef' }])
  assert.equal(view.find({ text: 'Waiting for you' }), null)
  await view.unmount()
})

test('a delete needs a second press', async () => {
  const deleted: string[] = []
  let current: PurserState = { ...empty, secrets: [row('NPM_TOKEN')] }
  const host = mockHost({
    requests: {
      'state.get': () => current,
      'secret.delete': ({ name }: { name: string }) => {
        deleted.push(name)
        current = { ...current, secrets: [] }
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Delete NPM_TOKEN' })
  assert.deepEqual(deleted, [])
  await view.press({ text: 'Delete' })
  assert.deepEqual(deleted, ['NPM_TOKEN'])
  await view.unmount()
})

test('the list shows names only, and when each was last used', async () => {
  const current: PurserState = { ...empty, secrets: [{ ...row('NPM_TOKEN'), lastUsedAt: Date.now() - 60_000 }] }
  const view = await mount(panel, { host: mockHost({ requests: { 'state.get': () => current } }) })
  assert.ok(view.find({ text: 'NPM_TOKEN' }))
  assert.ok(view.find({ text: /used/ }))
  assert.equal(view.find({ label: 'Name' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
