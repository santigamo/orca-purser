// The launch hook's command rewrite, checked against the commands Orca actually passes.
import { execFileSync } from 'node:child_process'
import { assert, test } from 'orca/testing'
import { INSTRUCTIONS, withInstructions } from './launch'

// Seen from Orca 1.4.264 for `orca agent launch --agent claude|codex`.
const CLAUDE = "claude '--dangerously-skip-permissions'"
const CODEX = "codex '-c' 'disable_paste_burst=true' '--dangerously-bypass-approvals-and-sandbox'"

/** How a POSIX shell splits the command into arguments. */
function argv(command: string): string[] {
  const out = execFileSync('/bin/sh', ['-c', `${command.replace(/^\S+/, 'printf "%s\\0"')}`], { encoding: 'utf8' })
  return out.split('\0').slice(0, -1)
}

test('Claude gets the instructions as one appended system prompt', () => {
  const args = argv(withInstructions('claude', CLAUDE))
  assert.deepEqual(args, ['--dangerously-skip-permissions', '--append-system-prompt', INSTRUCTIONS])
})

test('Codex gets them as developer_instructions, a valid TOML string', () => {
  const args = argv(withInstructions('codex', CODEX))
  assert.deepEqual(args.slice(0, 3), ['-c', 'disable_paste_burst=true', '--dangerously-bypass-approvals-and-sandbox'])
  assert.equal(args[3], '-c')
  assert.equal(JSON.parse(args[4].replace(/^developer_instructions=/, '')), INSTRUCTIONS)
})

test('instructions the person passes themselves are left alone', () => {
  const own = `${CLAUDE} '--append-system-prompt' 'mine'`
  assert.equal(withInstructions('claude', own), own)
  const codexOwn = `${CODEX} '-c' 'developer_instructions="mine"'`
  assert.equal(withInstructions('codex', codexOwn), codexOwn)
})

test('other agents are not touched', () => {
  assert.equal(withInstructions('opencode', 'opencode'), 'opencode')
})
