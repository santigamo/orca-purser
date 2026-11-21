// The plugin's worker: keeps the secrets, answers the panel and the `purser` command, and
// hooks agent launches and tool calls. Orca transpiles this file when it loads: no build step.
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:net'
import type { OrcaWorkerApi } from 'orca/worker'
import { cleanValue, nameProblem, normalizeName, referencesName } from './names'
import type { AskRow, PurserState } from './protocol'
import { serve, stop, type Request } from './server'
import { installSetup, launcherPath, refreshLauncher, removeSetup, setupState, socketPath } from './setup'
import { Store } from './store'

type Ask = AskRow & { settle: Set<(outcome: 'provided' | 'declined') => void> }

/** Tool names agents give their shell tool. Only Claude Code waits for the hook's answer. */
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'local_shell'])

let shutdown: (() => Promise<void>) | null = null

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const store = new Store(orca)
  const asks = new Map<string, Ask>()
  const socket = socketPath()
  let server: Server | null = null
  let protection: PurserState['protection'] = 'os-keyring'

  async function state(): Promise<PurserState> {
    await store.ready()
    return {
      protection,
      secrets: store.rows(),
      asks: [...asks.values()].map(({ settle: _settle, ...row }) => row).sort((a, b) => a.at - b.at),
      setup: await setupState(),
      serving: server !== null
    }
  }

  /** Tells every open panel and the status bar what changed, and answers the caller. */
  async function changed(): Promise<PurserState> {
    const next = await state()
    orca.panels.post('state.changed', next)
    const waiting = next.asks.length
    void orca.host
      .call('statusBar.update', {
        id: 'purser',
        text: waiting ? `Purser: ${waiting} waiting` : 'Purser',
        tone: waiting ? 'warning' : 'neutral',
        tooltip: waiting
          ? `An agent is waiting for ${next.asks.map((ask) => ask.name).join(', ')}. Open the Purser panel.`
          : `Purser: ${next.secrets.length} ${next.secrets.length === 1 ? 'secret' : 'secrets'} stored`
      })
      .catch(() => undefined)
    return next
  }

  function settleAsks(name: string, outcome: 'provided' | 'declined'): void {
    for (const [id, ask] of asks) {
      if (ask.name !== name) continue
      asks.delete(id)
      for (const settle of ask.settle) settle(outcome)
    }
  }

  function checkedName(raw: unknown): string {
    const name = normalizeName(typeof raw === 'string' ? raw : '')
    const problem = nameProblem(name)
    if (problem) throw invalid(problem)
    return name
  }

  // --- The panel -------------------------------------------------------------------------

  orca.panels.handle('state.get', () => state())

  orca.panels.handle('secret.save', async ({ name: rawName, value: rawValue }) => {
    const name = checkedName(rawName)
    const value = cleanValue(typeof rawValue === 'string' ? rawValue : '')
    if (!value) throw invalid('Paste the value to store.')
    if (protection === 'unavailable') throw invalid('This machine has no key store to protect secrets with.')
    await store.save(name, value)
    settleAsks(name, 'provided')
    return changed()
  })

  orca.panels.handle('secret.delete', async ({ name }) => {
    await store.delete(normalizeName(name))
    return changed()
  })

  orca.panels.handle('secret.export', async ({ name, exported }) => {
    await store.setExported(normalizeName(name), exported === true)
    return changed()
  })

  orca.panels.handle('ask.decline', async ({ id }) => {
    const ask = asks.get(id)
    if (ask) settleAsks(ask.name, 'declined')
    return changed()
  })

  orca.panels.handle('setup.install', async () => {
    await installSetup()
    return changed()
  })

  orca.panels.handle('setup.remove', async () => {
    await removeSetup()
    return changed()
  })

  orca.commands.register('purser.status', async () => {
    const { secrets, asks: waiting } = await state()
    const stored = secrets.length
      ? `Stored: ${secrets.map((secret) => secret.name).join(', ')}.`
      : 'Nothing stored yet. Open the Purser panel in the right sidebar to add a secret.'
    return waiting.length
      ? `${stored} Waiting for you in the Purser panel: ${waiting.map((ask) => ask.name).join(', ')}.`
      : stored
  })

  // --- The `purser` command ----------------------------------------------------------------

  async function handle(request: Request, { signal }: { signal: AbortSignal }): Promise<Record<string, unknown>> {
    await store.ready()
    if (request.op === 'list') {
      return {
        secrets: store.rows().map(({ name, exported, short }) => ({ name, exported, short })),
        waiting: [...asks.values()].map((ask) => ask.name)
      }
    }
    if (request.op === 'env') {
      const wanted = Array.isArray(request.names)
        ? request.names.filter((name): name is string => typeof name === 'string')
        : undefined
      const result = await store.valuesOf(wanted)
      void store.markUsed(Object.keys(result.values)).then(changed, () => undefined)
      return result
    }
    if (request.op === 'need') {
      const name = checkedName(request.name)
      if (store.has(name)) return { status: 'available' }
      if (protection === 'unavailable') throw new Error('this machine has no key store, so Purser cannot store secrets')
      let ask = [...asks.values()].find((entry) => entry.name === name)
      if (!ask) {
        const reason = typeof request.reason === 'string' ? request.reason.slice(0, 300) : ''
        const from = typeof request.from === 'string' && request.from ? request.from.slice(0, 80) : 'An agent'
        ask = { id: randomUUID(), name, reason, from, at: Date.now(), settle: new Set() }
        asks.set(ask.id, ask)
        void orca.host
          .call('notifications.show', {
            title: `${from} needs ${name}`,
            body: reason ? `${reason} Paste it in the Purser panel.` : 'Paste it in the Purser panel.'
          })
          .catch(() => undefined)
        await changed()
      }
      const waitingOn = ask
      // The request outlives this connection: if the command line gives up, the panel still asks.
      const outcome = await new Promise<'provided' | 'declined' | 'gone'>((resolve) => {
        const settle = (result: 'provided' | 'declined'): void => resolve(result)
        waitingOn.settle.add(settle)
        signal.addEventListener('abort', () => {
          waitingOn.settle.delete(settle)
          resolve('gone')
        })
      })
      return { status: outcome }
    }
    throw new Error(`unknown request "${request.op}"`)
  }

  // --- Hooks ---------------------------------------------------------------------------------

  // New agents get the secrets marked "export", and where the command lives. Reads memory only:
  // a launch must never wait on the key store.
  orca.hooks.on('agent.launch.before', (event, next) =>
    next({ ...event, env: { ...event.env, ...store.exportedValues(), PURSER_CLI: launcherPath() } })
  )

  // Claude Code waits for this answer, so a command that reads a secret the shell does not have
  // is turned back with how to run it. Without it the command would run with an empty variable.
  orca.hooks.on('agent.tool.before', (event) => {
    if (!SHELL_TOOLS.has(event.tool)) return
    const input = event.input as { command?: unknown } | null
    const command = Array.isArray(input?.command) ? input.command.join(' ') : input?.command
    // Already going through Purser: by name, by the full path, or by $PURSER_CLI.
    if (typeof command !== 'string' || /(^|[\s/;&|("'])purser["']?(\s|$)|\$\{?PURSER_CLI\b/.test(command)) return
    const name = store.names().find((entry) => !store.isExported(entry) && referencesName(command, entry))
    if (!name) return
    return {
      deny:
        `$${name} is kept in Purser and is not in this shell's environment. ` +
        `Run the command through Purser, writing the secret as {{${name}}}: ` +
        `purser run -- curl -H "Authorization: Bearer {{${name}}}" https://api.example.com ` +
        `(or keep $${name} and single-quote the script: purser run -- sh -c '...$${name}...'). ` +
        `If purser is not on PATH, use "$PURSER_CLI" or ~/.purser/bin/purser. Never print the value.`
    }
  })

  // --- Start -----------------------------------------------------------------------------------

  protection = await orca.host
    .call('secrets.protection')
    .then((result) => result.status)
    .catch(() => 'os-keyring' as const)
  await store.ready().catch((error: unknown) => orca.log(`could not read stored secrets: ${String(error)}`))
  await refreshLauncher().catch((error: unknown) => orca.log(`could not write the purser launcher: ${String(error)}`))
  server = await serve(socket, handle, (message) => orca.log(message)).catch((error: unknown) => {
    orca.log(`could not open ${socket}: ${String(error)}`)
    return null
  })
  if (!server) orca.log(`not serving on ${socket}: another Purser already is, or it could not be opened`)
  void changed().catch(() => undefined)

  shutdown = async () => {
    for (const ask of asks.values()) for (const settle of ask.settle) settle('declined')
    asks.clear()
    await stop(server, socket)
    server = null
  }
}

export async function deactivate(): Promise<void> {
  await shutdown?.()
  shutdown = null
}
