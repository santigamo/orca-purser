// The panel against a stand-in worker.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { PurserState } from './protocol'

const empty: PurserState = {
  protection: 'os-keyring',
  secrets: [],
  asks: [],
  setup: [
    { id: 'cli', label: 'purser command', path: '/Users/me/.local/bin/purser', state: 'missing' },
    { id: 'skill-claude', label: 'Skill for Claude Code', path: '/Users/me/.claude/skills/purser/SKILL.md', state: 'missing' },
    { id: 'skill-agents', label: 'Skill for Codex and other agents', path: '/Users/me/.agents/skills/purser/SKILL.md', state: 'missing' }
  ],
  serving: true
}

const row = (name: string) => ({ name, createdAt: 1, updatedAt: 1, lastUsedAt: null, exported: false, short: false })

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
  assert.match(view.summary().join("\n"), /No secrets yet/)

  await view.type({ label: 'Name' }, 'stripe api key')
  assert.ok(view.find({ text: 'Saved as STRIPE_API_KEY' }))
  await view.type({ label: 'Value' }, 'sk_test_123456', { submit: true })

  assert.deepEqual(saved, [{ name: 'STRIPE_API_KEY', value: 'sk_test_123456' }])
  assert.equal(view.valueOf({ label: 'Value' }), '')
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
  assert.ok(view.find({ text: /Codex in api is waiting for it: to run the evals/ }))
  await view.type({ label: 'Value for OPENAI_API_KEY' }, 'sk-proj-abcdef')
  await view.press({ text: 'Save and continue' })
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

test('warns before an agent login key goes to every agent', async () => {
  const current: PurserState = { ...empty, secrets: [{ ...row('ANTHROPIC_API_KEY'), exported: true }] }
  const view = await mount(panel, { host: mockHost({ requests: { 'state.get': () => current } }) })
  assert.ok(view.find({ text: /bill this key instead of your subscription/ }))
  await view.unmount()
})
