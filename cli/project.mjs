// Which project a folder belongs to: the Git repository, counting every worktree of it as the
// same project. Shared by the `purser` command (the agent's folder) and the plugin's worker
// (the workspace focused in Orca), so both name a project the same way.
import { execFileSync } from 'node:child_process'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

/** `{ key, name }` for the repository holding `dir`, or null outside one (or without git). */
export function projectOf(dir) {
  let common
  try {
    common = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    }).trim()
  } catch {
    return null
  }
  if (!common) return null
  const absolute = isAbsolute(common) ? common : resolve(dir, common)
  // A normal checkout keeps it in <root>/.git; a bare repository is the folder itself.
  const root = basename(absolute) === '.git' ? dirname(absolute) : absolute.replace(/\.git$/, '')
  return { key: root, name: basename(root) }
}
