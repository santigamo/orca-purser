// What the launch hook adds to an agent's command line so it knows about Purser without any
// skill or command being installed. Orca passes the command as a shell string with each
// argument single-quoted (`claude '--dangerously-skip-permissions'`), so appending quoted
// arguments is safe.

/** Short on purpose: it is read on every turn. The skill says the same at more length. */
export const INSTRUCTIONS = [
  'Secrets (API keys, tokens, passwords) are kept in Orca by the Purser plugin. Never ask the user to paste one in the chat and never write one to a file, a commit or a command line.',
  'List the stored names: "$PURSER_CLI" list.',
  'Use one: "$PURSER_CLI" run -- <command>, writing {{NAME}} where the value goes, e.g. "$PURSER_CLI" run -- curl -H "Authorization: Bearer {{STRIPE_API_KEY}}" https://api.stripe.com/v1/balance. Inside the command $NAME is also set, so you can run "$PURSER_CLI" run -- sh -c followed by a single-quoted script that reads $NAME. Your own shell does not have these variables.',
  'If one is missing: "$PURSER_CLI" need NAME "why you need it". The user is asked in Orca and the command waits. Exit 0: stored, go on. Exit 75: still waiting, tell the user and run it again. Exit 77: declined, do not ask again.',
  'Values in command output appear as [purser:NAME]. Never print, encode or otherwise reveal a value.'
].join(' ')

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** The first word of the command, without a path: `/opt/bin/claude '-x'` is `claude`. */
function program(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return first.replace(/^['"]|['"]$/g, '').split('/').pop() ?? ''
}

/**
 * The command with Purser's instructions added, or unchanged for agents Purser does not know
 * how to instruct, and when the person already passes instructions of their own that the
 * flag would replace.
 */
export function withInstructions(agent: string, command: string): string {
  const name = program(command)
  if (agent === 'claude' || name === 'claude') {
    if (/append-system-prompt/.test(command)) return command
    return `${command} --append-system-prompt ${shellQuote(INSTRUCTIONS)}`
  }
  if (agent === 'codex' || name === 'codex') {
    if (/developer_instructions/.test(command)) return command
    // A TOML basic string: JSON's escaping is valid TOML for this text.
    return `${command} -c ${shellQuote(`developer_instructions=${JSON.stringify(INSTRUCTIONS)}`)}`
  }
  return command
}
