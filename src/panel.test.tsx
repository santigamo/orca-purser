// The panel against a stand-in worker.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Project, PurserState, SecretRow } from './protocol'

const clientA: Project = { key: '/work/client-a', name: 'client-a' }
const clientB: Project = { key: '/work/client-b', name: 'client-b' }

const empty: PurserState = { protection: 'os-keyring', secrets: [], asks: [], currentProject: null, serving: true }

function row(name: string, project: Project | null = null): SecretRow {
  const id = project ? `p:${project.name}:${name}` : name
  return { id, name, project, storageKey: `secret:${id}`, createdAt: 1, updatedAt: 1, lastUsedAt: null, short: false }
}

test('the add form stays hidden until asked for, then stores in the current project', async () => {
  const saved: unknown[] = []
  let current: PurserState = { ...empty, currentProject: clientA }
  const host = mockHost({
    requests: {
      'state.get': () => current,
      'secret.save': (input: { name: string; value: string; project: Project | null }) => {
        saved.push(input)
        current = { ...current, secrets: [row(input.name, input.project)] }
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  assert.match(view.summary().join('\n'), /No secrets yet/)
  assert.equal(view.find({ label: 'Name' }), null)

  await view.press({ label: 'Add a secret' })
  await view.type({ label: 'Name' }, 'stripe api key')
  assert.ok(view.find({ text: 'Saved as STRIPE_API_KEY' }))
  await view.type({ label: 'Value' }, 'sk_test_123456', { submit: true })

  assert.deepEqual(saved, [{ name: 'STRIPE_API_KEY', value: 'sk_test_123456', project: clientA }])
  assert.equal(view.find({ label: 'Value' }), null, 'the form closes after saving')
  assert.ok(view.find({ text: 'This project · client-a' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a waiting agent is answered into its project, or into all of them', async () => {
  const saved: { project: Project | null }[] = []
  let current: PurserState = {
    ...empty,
    asks: [{ id: 'a1', name: 'OPENAI_API_KEY', reason: 'to run the evals', from: 'Codex in api', project: clientA, at: Date.now() }]
  }
  const host = mockHost({
    requests: {
      'state.get': () => current,
      'secret.save': (input: { name: string; value: string; project: Project | null }) => {
        saved.push(input)
        current = { ...current, asks: [], secrets: [row(input.name, input.project)] }
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Codex in api is waiting for' }))
  assert.equal(view.valueOf({ label: 'Where to use OPENAI_API_KEY' }), clientA.key)
  await view.select({ label: 'Where to use OPENAI_API_KEY' }, '__global__')
  await view.type({ label: 'Value for OPENAI_API_KEY' }, 'sk-proj-abcdef')
  await view.press({ text: 'Save' })
  assert.deepEqual(saved.map((input) => input.project), [null])
  await view.unmount()
})

test('secrets group by project, other projects fold away', async () => {
  const current: PurserState = {
    ...empty,
    currentProject: clientA,
    secrets: [row('STRIPE_API_KEY', clientA), row('STRIPE_API_KEY'), row('NPM_TOKEN'), row('DB_URL', clientB)]
  }
  const view = await mount(panel, { host: mockHost({ requests: { 'state.get': () => current } }) })
  assert.ok(view.find({ text: 'This project · client-a' }))
  assert.ok(view.find({ text: 'All projects' }))
  assert.ok(view.find({ text: /this project uses its own/ }), 'the global one it overrides says so')
  assert.ok(view.find({ type: 'Collapsible' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('show reads the value in the panel and hide forgets it', async () => {
  const current: PurserState = { ...empty, secrets: [row('NPM_TOKEN')] }
  const host = mockHost({
    capabilities: ['secrets:own'],
    secrets: { 'secret:NPM_TOKEN': 'npm_visible_value' },
    requests: { 'state.get': () => current }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'npm_visible_value' }), null)
  await view.press({ text: 'Show' })
  assert.ok(view.find({ text: 'npm_visible_value' }))
  await view.press({ text: 'Hide' })
  assert.equal(view.find({ text: 'npm_visible_value' }), null)
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('edit sends only what changed', async () => {
  const updates: unknown[] = []
  let current: PurserState = { ...empty, currentProject: clientA, secrets: [row('NPM_TOKEN')] }
  const host = mockHost({
    requests: {
      'state.get': () => current,
      'secret.update': (input: { id: string; value?: string; project?: Project | null }) => {
        updates.push(input)
        return current
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Edit NPM_TOKEN' })
  await view.type({ label: 'New value' }, 'npm_new_value')
  await view.press({ text: 'Save' })
  await view.press({ label: 'Edit NPM_TOKEN' })
  await view.select({ label: 'Use in' }, clientA.key)
  await view.press({ text: 'Save' })
  assert.deepEqual(updates, [{ id: 'NPM_TOKEN', value: 'npm_new_value' }, { id: 'NPM_TOKEN', project: clientA }])
  await view.unmount()
})

test('a delete needs a second press', async () => {
  const deleted: string[] = []
  let current: PurserState = { ...empty, secrets: [row('NPM_TOKEN')] }
  const host = mockHost({
    requests: {
      'state.get': () => current,
      'secret.delete': ({ id }: { id: string }) => {
        deleted.push(id)
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
