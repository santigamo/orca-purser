// Brings the Purser panel into Orca's right sidebar when an agent asks for a secret, so the
// person pastes it next to the conversation instead of hunting for the panel. The plugin API has
// no call for this, so it uses the `orca` command that ships with Orca; any failure only means
// the panel stays where it was (the notification and the status bar still say what is waiting).
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'

const PANEL = 'purser'

type Run = (args: string[]) => Promise<{ ok: boolean; result?: unknown }>

/** The `orca` next to the Orca running this worker (it is Orca's own binary), then PATH. */
async function findOrca(env = process.env, execPath = process.execPath): Promise<string | null> {
  if (env.PURSER_ORCA_CLI) return env.PURSER_ORCA_CLI
  const app = execPath.includes('.app/Contents/')
    ? join(execPath.slice(0, execPath.indexOf('.app/Contents/') + '.app/Contents/'.length), 'Resources', 'bin')
    : join(dirname(execPath), 'resources', 'bin')
  for (const dir of [app, ...(env.PATH ?? '').split(delimiter).filter(Boolean)]) {
    const candidate = join(dir, process.platform === 'win32' ? 'orca.exe' : 'orca')
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

function runner(cli: string): Run {
  return (args) =>
    new Promise((resolve) => {
      execFile(cli, [...args, '--json'], { timeout: 10_000, windowsHide: true }, (_error, stdout) => {
        try {
          const answer = JSON.parse(String(stdout).trim())
          resolve({ ok: answer.ok === true, result: answer.result })
        } catch {
          resolve({ ok: false })
        }
      })
    })
}

/** This plugin's install key: `local.purser` in development, `<owner>.purser` once installed. */
async function ownKey(run: Run): Promise<string | null> {
  const { ok, result } = await run(['plugin', 'list'])
  if (!ok) return null
  const rows = (Array.isArray(result) ? result : (result as { plugins?: unknown[] })?.plugins) ?? []
  const mine = (rows as { pluginKey?: string; status?: string }[]).filter((row) => row.pluginKey?.endsWith(`.${PANEL}`))
  return (mine.find((row) => row.status === 'running') ?? mine[0])?.pluginKey ?? null
}

/** Returns a function that shows the panel; it never throws and never waits on its caller. */
export function panelOpener(log: (message: string) => void, make: () => Promise<Run | null> = async () => {
  const cli = await findOrca()
  return cli ? runner(cli) : null
}) {
  let key: Promise<{ run: Run; key: string } | null> | null = null
  return async (): Promise<boolean> => {
    key ??= make().then(async (run) => {
      if (!run) return null
      const found = await ownKey(run)
      return found ? { run, key: found } : null
    })
    const target = await key
    if (!target) {
      key = null
      log('could not find the orca command or this plugin, so the panel was not opened')
      return false
    }
    const { ok } = await target.run(['plugin', 'open', target.key, '--panel', PANEL])
    if (!ok) log('orca plugin open failed; the panel was not brought forward')
    return ok
  }
}
