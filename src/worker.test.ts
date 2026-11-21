// The worker over a mock host, and the `purser` command against it over a real socket.
// Everything lives in a temporary home: these tests never touch ~/.purser or the real skills.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
// @ts-expect-error plain JavaScript, no declaration file
import { main as cli } from '../cli/purser.mjs'

const CAPABILITIES = ['secrets:own', 'storage:own', 'notifications:show']
const HOOKS = ['agent.launch.before', 'agent.tool.before']
const COMMANDS = ['purser.status', 'purser.setupOutside', 'purser.removeOutside']
const TOKEN = 'sk_test_51Habc0123456789xyz'

let home = ''
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'purser-'))
  process.env.PURSER_HOME_DIR = home
  delete process.env.PURSER_SOCK
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function start(secrets: Record<string, string> = {}, index: Record<string, unknown> = {}) {
  const host = mockHost({
    capabilities: CAPABILITIES,
    secrets,
    storage: Object.keys(index).length ? { index: index as never } : {},
    results: { 'secrets.protection': { status: 'os-keyring' } }
  })
  const worker = await mountWorker(main, { host, hooks: HOOKS, commands: COMMANDS })
  return { host, worker }
}

function io(env: Record<string, string | undefined> = {}) {
  const out: string[] = []
  const err: string[] = []
  return {
    env: { ...process.env, PURSER_HOME_DIR: home, ...env },
    cwd: home,
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    stdout: () => out.join(''),
    stderr: () => err.join('')
  }
}

const meta = () => ({ createdAt: 1, updatedAt: 1, lastUsedAt: null, short: false })

test('the panel saves a secret, lists it by name only, and deletes it', async () => {
  const { host, worker } = await start()
  const saved = await worker.request('secret.save', { name: ' stripe-api key ', value: `  ${TOKEN}\n` })
  assert.deepEqual(saved.secrets.map((row) => row.name), ['STRIPE_API_KEY'])
  assert.equal(host.data().secrets['secret:STRIPE_API_KEY'], TOKEN)
  assert.ok(!JSON.stringify(saved).includes(TOKEN), 'no answer to the panel carries a value')

  const gone = await worker.request('secret.delete', { name: 'STRIPE_API_KEY' })
  assert.deepEqual(gone.secrets, [])
  assert.equal(host.data().secrets['secret:STRIPE_API_KEY'], undefined)
  await worker.deactivate()
})

test('names that steer the shell are refused', async () => {
  const { worker } = await start()
  for (const name of ['PATH', 'LD_PRELOAD', 'GIT_SSH_COMMAND', '1KEY', 'a b$c']) {
    await assert.rejects(worker.request('secret.save', { name, value: TOKEN }), () => true)
  }
  await worker.deactivate()
})

test('new agents get the command path and instructions, never a secret value', async () => {
  const { worker } = await start(
    { 'secret:NPM_TOKEN': 'npm_abcdef123456', 'secret:STRIPE_API_KEY': TOKEN },
    { NPM_TOKEN: meta(), STRIPE_API_KEY: meta() }
  )
  const decision = await worker.hooks.fire('agent.launch.before', {
    agent: 'claude',
    workspaceId: 'w1',
    workspaceKind: 'worktree',
    command: 'claude',
    env: { KEEP: '1' }
  })
  assert.equal(decision.kind, 'continue')
  const env = decision.kind === 'continue' ? decision.event.env : {}
  assert.equal(env.KEEP, '1')
  assert.equal(env.NPM_TOKEN, undefined)
  assert.equal(env.STRIPE_API_KEY, undefined)
  assert.equal(env.PURSER_CLI, join(home, '.purser', 'bin', 'purser'))
  assert.match(decision.kind === 'continue' ? decision.event.command : '', /^claude --append-system-prompt '.*PURSER_CLI/)
  await worker.deactivate()
})

test('a Bash call that reads a secret its shell lacks is turned back with how to run it', async () => {
  const { worker } = await start({ 'secret:STRIPE_API_KEY': TOKEN }, { STRIPE_API_KEY: meta() })
  const fire = (command: string, tool = 'Bash') =>
    worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: 'w1', tool, input: { command } })

  const denied = await fire('curl -H "Authorization: Bearer $STRIPE_API_KEY" https://api.stripe.com')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.kind === 'deny' ? denied.reason : '', /purser run -- .*\{\{STRIPE_API_KEY\}\}/)

  assert.equal((await fire('echo ${STRIPE_API_KEY:-none}')).kind, 'deny')
  assert.equal((await fire("purser run -- sh -c 'curl -u $STRIPE_API_KEY: x'")).kind, 'continue')
  assert.equal((await fire(`"$PURSER_CLI" run -- sh -c 'curl -u $STRIPE_API_KEY: x'`)).kind, 'continue')
  assert.equal((await fire(`~/.purser/bin/purser run -- sh -c 'curl -u $STRIPE_API_KEY: x'`)).kind, 'continue')
  assert.equal((await fire('echo $STRIPE_API_KEY_OTHER')).kind, 'continue')
  assert.equal((await fire('ls')).kind, 'continue')
  assert.equal((await fire('$STRIPE_API_KEY', 'Read')).kind, 'continue')
  await worker.deactivate()
})

test('purser need waits for the panel, then purser run uses and hides the value', async () => {
  const { host, worker } = await start()
  const asker = io({ CLAUDECODE: '1' })
  const waiting = cli(['need', 'STRIPE_API_KEY', 'to', 'read', 'the', 'balance'], asker)

  // The ask reaches the panel and a notification.
  let asks: { id: string; name: string; from: string; reason: string }[] = []
  for (let tries = 0; tries < 50 && !asks.length; tries += 1) {
    asks = (await worker.request('state.get')).asks
    if (!asks.length) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(asks.length, 1)
  assert.equal(asks[0].name, 'STRIPE_API_KEY')
  assert.equal(asks[0].reason, 'to read the balance')
  assert.match(asks[0].from, /^Claude Code in purser-/)
  assert.equal(host.callsOf('notifications.show').length, 1)

  await worker.request('secret.save', { name: 'STRIPE_API_KEY', value: TOKEN })
  assert.equal(await waiting, 0)
  assert.match(asker.stdout(), /STRIPE_API_KEY was just stored/)
  assert.deepEqual((await worker.request('state.get')).asks, [])

  const runner = io()
  const code = await cli(
    ['run', '--', process.execPath, '-e', 'console.log(process.argv[1], process.env.STRIPE_API_KEY, btoa(process.argv[1]))', '{{STRIPE_API_KEY}}'],
    runner
  )
  assert.equal(code, 0)
  assert.equal(runner.stdout().trim(), '[purser:STRIPE_API_KEY] [purser:STRIPE_API_KEY] [purser:STRIPE_API_KEY]')
  assert.ok(!runner.stdout().includes(TOKEN))

  const listed = io()
  await cli(['list'], listed)
  assert.match(listed.stdout(), /^STRIPE_API_KEY$/m)
  assert.ok(!listed.stdout().includes(TOKEN))
  await worker.deactivate()
})

test('declining an ask ends the wait with its own exit code', async () => {
  const { worker } = await start()
  const asker = io()
  const waiting = cli(['need', 'OPENAI_API_KEY'], asker)
  let id = ''
  for (let tries = 0; tries < 50 && !id; tries += 1) {
    id = (await worker.request('state.get')).asks[0]?.id ?? ''
    if (!id) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await worker.request('ask.decline', { id })
  assert.equal(await waiting, 77)
  assert.match(asker.stderr(), /declined/)
  await worker.deactivate()
})

test('a wait that runs out leaves the ask open and says to run it again', async () => {
  const { worker } = await start()
  const asker = io({ PURSER_WAIT_SECONDS: '0.2' })
  assert.equal(await cli(['need', 'GH_TOKEN'], asker), 75)
  assert.match(asker.stderr(), /still waiting/)
  assert.deepEqual((await worker.request('state.get')).asks.map((ask) => ask.name), ['GH_TOKEN'])
  await worker.deactivate()
})

test('run refuses a name that is not stored and says how to ask for it', async () => {
  const { worker } = await start()
  const runner = io()
  assert.equal(await cli(['run', '--', 'echo', '{{MISSING_KEY}}'], runner), 78)
  assert.match(runner.stderr(), /purser need MISSING_KEY/)
  await worker.deactivate()
})

test('without Orca the command says what to do', async () => {
  const runner = io()
  assert.equal(await cli(['list'], runner), 69)
  assert.match(runner.stderr(), /open Orca/)
})

test('the palette commands set up and remove agents outside Orca', async () => {
  const { worker } = await start()
  assert.match(String(await worker.command('purser.setupOutside')), /Installed: ~\/\.local\/bin\/purser/)
  assert.match(await readFile(join(home, '.claude', 'skills', 'purser', 'SKILL.md'), 'utf8'), /name: purser/)
  assert.match(await readFile(join(home, '.agents', 'skills', 'purser', 'SKILL.md'), 'utf8'), /name: purser/)
  assert.equal((await stat(join(home, '.local', 'bin', 'purser'))).mode & 0o111, 0o111)
  await worker.command('purser.removeOutside')
  await assert.rejects(stat(join(home, '.claude', 'skills', 'purser')))
  await assert.rejects(stat(join(home, '.local', 'bin', 'purser')))
  await worker.deactivate()
})

test('rows saved by 0.1.0 with an export flag still load', async () => {
  const { worker } = await start({ 'secret:OLD_TOKEN': 'old_token_value' }, { OLD_TOKEN: { ...meta(), exported: true } })
  const { secrets } = await worker.request('state.get')
  assert.deepEqual(Object.keys(secrets[0]).sort(), ['createdAt', 'lastUsedAt', 'name', 'short', 'updatedAt'])
  await worker.deactivate()
})

test('the socket is private to this user', async () => {
  const { worker } = await start()
  assert.equal((await stat(join(home, '.purser'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(home, '.purser', 'purser.sock'))).mode & 0o777, 0o600)
  await worker.deactivate()
})
