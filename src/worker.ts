// The plugin's worker: keeps the secrets, answers the panel and the `purser` command, and
// hooks agent launches and tool calls. Orca transpiles this file when it loads: no build step.
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:net'
import type { OrcaWorkerApi } from 'orca/worker'
import { withInstructions } from './launch'
import { cleanValue, nameProblem, normalizeName, referencesName } from './names'
import type { AskRow, Project, PurserState } from './protocol'
import { serve, stop, type Request } from './server'
import { home, installSetup, launcherPath, refreshLauncher, removeSetup, setupState, socketPath } from './setup'
import { Store } from './store'
import { projectOf } from '../cli/project.mjs'

type Ask = AskRow & { settle: Set<(outcome: 'provided' | 'declined') => void> }

/** Tool names agents give their shell tool. Only Claude Code waits for the hook's answer. */
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'local_shell'])

let shutdown: (() => Promise<void>) | null = null

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

/** A project as a caller sent it, checked: an absolute folder and a short name. */
function checkedProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null
  const { key, name } = raw as Record<string, unknown>
  if (typeof key !== 'string' || !key.startsWith('/') || key.length > 4096) return null
  return { key, name: typeof name === 'string' && name ? name.slice(0, 120) : key.split('/').pop() || key }
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const store = new Store(orca)
  const asks = new Map<string, Ask>()
  const socket = socketPath()
  let server: Server | null = null
  let protection: PurserState['protection'] = 'os-keyring'
  let currentProject: Project | null = null

  async function state(): Promise<PurserState> {
    await store.ready()
    return {
      protection,
      secrets: store.rows(),
      asks: [...asks.values()].map(({ settle: _settle, ...row }) => row).sort((a, b) => a.at - b.at),
      currentProject,
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

  function settle(id: string, outcome: 'provided' | 'declined'): void {
    const ask = asks.get(id)
    if (!ask) return
    asks.delete(id)
    for (const done of ask.settle) done(outcome)
  }

  /** Every ask that a stored secret now answers, in the project it was asked from. */
  function settleAnswered(): void {
    for (const ask of [...asks.values()]) {
      if (store.resolve(ask.name, ask.project)) settle(ask.id, 'provided')
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

  orca.panels.handle('secret.save', async ({ name: rawName, value: rawValue, project }) => {
    const name = checkedName(rawName)
    const value = cleanValue(typeof rawValue === 'string' ? rawValue : '')
    if (!value) throw invalid('Paste the value to store.')
    if (protection === 'unavailable') throw invalid('This machine has no key store to protect secrets with.')
    await store.save(name, checkedProject(project), value)
    settleAnswered()
    return changed()
  })

  orca.panels.handle('secret.update', async ({ id, value: rawValue, project }) => {
    const value = rawValue === undefined ? undefined : cleanValue(String(rawValue))
    if (value === '') throw invalid('Paste the new value, or leave the field empty to keep the current one.')
    await store.update(String(id), {
      value,
      project: project === undefined ? undefined : checkedProject(project)
    }).catch((error: unknown) => {
      throw invalid(error instanceof Error ? error.message : String(error))
    })
    settleAnswered()
    return changed()
  })

  orca.panels.handle('secret.delete', async ({ id }) => {
    await store.delete(String(id))
    return changed()
  })

  orca.panels.handle('ask.decline', async ({ id }) => {
    settle(String(id), 'declined')
    return changed()
  })

  orca.commands.register('purser.setupOutside', async () => {
    await installSetup()
    const items = await setupState()
    return `Installed: ${items.map((item) => item.path.replace(home(), '~')).join(', ')}. Agents you start outside Orca can now use purser.`
  })

  orca.commands.register('purser.removeOutside', async () => {
    await removeSetup()
    return 'Removed the purser command and skill installed for agents outside Orca. Agents Orca starts keep working.'
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
    const project = checkedProject(request.project)
    if (request.op === 'list') {
      return {
        project,
        secrets: store.visible(project).map(({ name, short, project: owner }) => ({ name, short, project: owner?.name ?? null })),
        waiting: [...asks.values()].map((ask) => ask.name)
      }
    }
    if (request.op === 'env') {
      const wanted = Array.isArray(request.names)
        ? request.names.filter((name): name is string => typeof name === 'string')
        : undefined
      const { values, missing, ids } = await store.valuesFor(project, wanted)
      void store.markUsed(ids).then(changed, () => undefined)
      return { values, missing }
    }
    if (request.op === 'need') {
      const name = checkedName(request.name)
      if (store.resolve(name, project)) return { status: 'available' }
      if (protection === 'unavailable') throw new Error('this machine has no key store, so Purser cannot store secrets')
      let ask = [...asks.values()].find((entry) => entry.name === name && entry.project?.key === project?.key)
      if (!ask) {
        const reason = typeof request.reason === 'string' ? request.reason.slice(0, 300) : ''
        const from = typeof request.from === 'string' && request.from ? request.from.slice(0, 80) : 'An agent'
        ask = { id: randomUUID(), name, reason, from, project, at: Date.now(), settle: new Set() }
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
        const done = (result: 'provided' | 'declined'): void => resolve(result)
        waitingOn.settle.add(done)
        signal.addEventListener('abort', () => {
          waitingOn.settle.delete(done)
          resolve('gone')
        })
      })
      return { status: outcome }
    }
    throw new Error(`unknown request "${request.op}"`)
  }

  // --- Hooks ---------------------------------------------------------------------------------

  // New agents get where the command lives and how to use it, so nothing has to be installed
  // for agents Orca starts. No secret value goes into an agent's environment.
  orca.hooks.on('agent.launch.before', (event, next) =>
    next({
      ...event,
      command: withInstructions(event.agent, event.command),
      env: { ...event.env, PURSER_CLI: launcherPath() }
    })
  )

  // Claude Code waits for this answer, so a command that reads a secret the shell does not have
  // is turned back with how to run it. Without it the command would run with an empty variable.
  orca.hooks.on('agent.tool.before', (event) => {
    if (!SHELL_TOOLS.has(event.tool)) return
    const input = event.input as { command?: unknown } | null
    const command = Array.isArray(input?.command) ? input.command.join(' ') : input?.command
    // Already going through Purser: by name, by the full path, or by $PURSER_CLI.
    if (typeof command !== 'string' || /(^|[\s/;&|("'])purser["']?(\s|$)|\$\{?PURSER_CLI\b/.test(command)) return
    const name = store.names().find((entry) => referencesName(command, entry))
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

  // The panel groups secrets around the project of the focused workspace.
  orca.events.on('workspace.changed', async ({ context }) => {
    let next: Project | null = null
    if (context?.workspaceId) {
      const { workspaces } = await orca.host.call('workspace.list').catch(() => ({ workspaces: [] }))
      const focused = workspaces.find((row) => row.id === context.workspaceId)
      if (focused?.path && (focused.hostId === 'local' || focused.hostId === null)) next = projectOf(focused.path)
    }
    if (next?.key === currentProject?.key) return
    currentProject = next
    await changed()
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
    for (const ask of asks.values()) for (const done of ask.settle) done('declined')
    asks.clear()
    await stop(server, socket)
    server = null
  }
}

export async function deactivate(): Promise<void> {
  await shutdown?.()
  shutdown = null
}
