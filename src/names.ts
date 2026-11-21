// Secret names are environment variable names, so `$NAME` works in any shell. Shared by the
// panel (to guide typing) and the worker (which checks again: the panel is not the only caller).

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/

/** Names that steer the shell, the loader or a runtime instead of holding a credential. */
const RESERVED = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'OLDPWD', 'IFS', 'ENV', 'BASH_ENV', 'ZDOTDIR', 'TERM',
  'TMPDIR', 'LANG', 'EDITOR', 'VISUAL', 'PAGER', 'PS1', 'PS4', 'PROMPT_COMMAND', 'NODE_OPTIONS',
  'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'PERL5OPT', 'JAVA_TOOL_OPTIONS',
  'ELECTRON_RUN_AS_NODE'
])
const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'GIT_', 'PURSER_', 'ORCA_', 'LC_', 'XDG_']

/**
 * Keys an agent CLI reads for its own login. Exporting one to every agent can silently switch
 * it from the person's subscription to pay-per-use billing, so the panel warns before that.
 */
const AGENT_LOGIN = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY',
  'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'
])

/** Values shorter than this are not searched for in output: too likely to match by chance. */
export const MIN_REDACT_LENGTH = 6

/** What the person probably meant: "stripe key" and "$stripe-key" both become STRIPE_KEY. */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/^\$\{?/, '')
    .replace(/\}$/, '')
    .replace(/[\s.-]+/g, '_')
    .toUpperCase()
}

/** Why `name` cannot be used, in words for the person; null when it is fine. */
export function nameProblem(name: string): string | null {
  if (!name) return 'Give it a name, such as STRIPE_API_KEY.'
  if (!NAME.test(name)) {
    return /^[0-9]/.test(name)
      ? 'A name cannot start with a digit.'
      : 'Use letters, digits and underscores only, at most 64.'
  }
  if (RESERVED.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `${name} changes how the shell or a tool behaves, so it cannot hold a secret.`
  }
  return null
}

export function isAgentLogin(name: string): boolean {
  return AGENT_LOGIN.has(name)
}

/** Pasted values often carry a stray newline or space; nothing inside the value is touched. */
export function cleanValue(raw: string): string {
  return raw.replace(/^\s+|\s+$/g, '')
}

/** Whether `command` reads `$NAME` or `${NAME...}`. */
export function referencesName(command: string, name: string): boolean {
  return new RegExp(`\\$(?:${name}(?![A-Za-z0-9_])|\\{${name}[}:#%/^,-])`).test(command)
}
