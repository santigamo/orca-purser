// The panel opener against a stand-in `orca` command.
import { assert, test } from 'orca/testing'
import { panelOpener } from './open-panel'

function fakeOrca(plugins: unknown) {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'plugin' && args[1] === 'list') return { ok: true, result: plugins }
    return { ok: true, result: {} }
  }
  return { calls, make: async () => run }
}

test('opens this plugin\'s panel, preferring the running copy', async () => {
  const orca = fakeOrca([
    { pluginKey: 'santigamo.purser', status: 'disabled' },
    { pluginKey: 'local.purser', status: 'running' },
    { pluginKey: 'santigamo.regatta', status: 'running' }
  ])
  const open = panelOpener(() => undefined, orca.make)
  assert.equal(await open(), true)
  assert.equal(await open(), true)
  assert.deepEqual(orca.calls, [
    ['plugin', 'list'],
    ['plugin', 'open', 'local.purser', '--panel', 'purser'],
    ['plugin', 'open', 'local.purser', '--panel', 'purser']
  ])
})

test('without the orca command it logs and carries on', async () => {
  const logs: string[] = []
  const open = panelOpener((message) => logs.push(message), async () => null)
  assert.equal(await open(), false)
  assert.equal(logs.length, 1)
})
