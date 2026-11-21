// The few files Purser writes outside Orca so agents can find it: a `purser` command and a
// skill that tells Claude Code and Codex when to use it. Written only when the person asks,
// except the launcher in Purser's own folder, which every agent terminal is pointed at.
import { chmod, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SetupItem } from './protocol'

/** Tests point this at a temporary folder so they never touch the real home. */
export const home = (): string => process.env.PURSER_HOME_DIR || homedir()
export const stateDir = (): string => join(home(), '.purser')
export const socketPath = (): string => process.env.PURSER_SOCK || join(stateDir(), 'purser.sock')
/** A path that stays the same when the plugin updates or moves. */
export const launcherPath = (): string => join(stateDir(), 'bin', 'purser')

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** Runs the plugin's command with whatever Node this machine has, or Orca's own. */
function launcherScript(): string {
  return [
    '#!/bin/sh',
    '# Written by the Purser plugin for Orca, and rewritten when the plugin moves. Safe to delete.',
    `PURSER_NODE=${quote(process.execPath)} exec sh ${quote(join(PLUGIN_ROOT, 'bin', 'purser'))} "$@"`,
    ''
  ].join('\n')
}

async function writeIfChanged(path: string, content: string, mode?: number): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== content) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  if (mode !== undefined) await chmod(path, mode)
}

/** Keeps Purser's own launcher pointing at this copy of the plugin. Runs on every start. */
export async function refreshLauncher(): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  await writeIfChanged(launcherPath(), launcherScript(), 0o755)
  // The copy on PATH, if the person installed it, follows along.
  const onPath = targets().find((target) => target.id === 'cli')
  if (onPath && (await readFile(onPath.path, 'utf8').catch(() => null)) !== null) {
    await writeIfChanged(onPath.path, launcherScript(), 0o755)
  }
}

type Target = { id: SetupItem['id']; label: string; path: string; content: () => Promise<string>; mode?: number }

function targets(): Target[] {
  const skill = (): Promise<string> => readFile(join(PLUGIN_ROOT, 'skill', 'SKILL.md'), 'utf8')
  return [
    {
      id: 'cli',
      label: 'purser command',
      path: join(home(), '.local', 'bin', 'purser'),
      content: async () => launcherScript(),
      mode: 0o755
    },
    {
      id: 'skill-claude',
      label: 'Skill for Claude Code',
      path: join(home(), '.claude', 'skills', 'purser', 'SKILL.md'),
      content: skill
    },
    {
      id: 'skill-agents',
      label: 'Skill for Codex and other agents',
      path: join(home(), '.agents', 'skills', 'purser', 'SKILL.md'),
      content: skill
    }
  ]
}

export async function setupState(): Promise<SetupItem[]> {
  return Promise.all(
    targets().map(async ({ id, label, path, content }) => {
      const current = await readFile(path, 'utf8').catch(() => null)
      const state = current === null ? 'missing' : current === (await content()) ? 'installed' : 'outdated'
      return { id, label, path, state } as SetupItem
    })
  )
}

export async function installSetup(): Promise<void> {
  for (const { path, content, mode } of targets()) {
    await writeIfChanged(path, await content(), mode)
  }
}

export async function removeSetup(): Promise<void> {
  for (const { id, path } of targets()) {
    await rm(path, { force: true })
    // A skill folder Purser made is removed with its file; anything else in it stays.
    if (id !== 'cli') await rmdir(dirname(path)).catch(() => undefined)
  }
}
