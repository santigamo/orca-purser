// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// No request ever answers with a secret's value. The panel reads one itself, from the encrypted
// store, only while the person asks to see it.

/** A Git repository; its worktrees are the same project. `key` is the repository's folder. */
export type Project = { key: string; name: string }

/** One stored secret, as the panel lists it. */
export type SecretRow = {
  /** Unique: the same name can be stored once globally and once per project. */
  id: string
  name: string
  /** null: usable in every project. */
  project: Project | null
  /** Where the value sits in the plugin's encrypted secrets, for the panel's "show". */
  storageKey: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  /** Too short to find and hide in command output. */
  short: boolean
}

/** An agent ran `purser need NAME` and waits for the person to paste it. */
export type AskRow = {
  id: string
  name: string
  reason: string
  /** Who asks, as far as the command line could tell: "Claude Code in my-repo". */
  from: string
  /** The project the agent works in, where the answer is stored by default. */
  project: Project | null
  at: number
}

/** One file Purser can write for agents started outside Orca. */
export type SetupItem = {
  id: 'cli' | 'skill-claude' | 'skill-agents'
  label: string
  path: string
  state: 'installed' | 'outdated' | 'missing'
}

export type PurserState = {
  /** `unavailable`: this machine has no OS key store, so nothing can be saved. */
  protection: 'os-keyring' | 'unavailable'
  secrets: SecretRow[]
  asks: AskRow[]
  /** The project of the workspace focused in Orca, if it is in a Git repository. */
  currentProject: Project | null
  /** Whether the local socket the `purser` command talks to is up. */
  serving: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'state.get': { output: PurserState }
    'secret.save': { input: { name: string; value: string; project: Project | null }; output: PurserState }
    /** Leave `value` out to keep it; leave `project` out to keep where it is. */
    'secret.update': { input: { id: string; value?: string; project?: Project | null }; output: PurserState }
    'secret.delete': { input: { id: string }; output: PurserState }
    'ask.decline': { input: { id: string }; output: PurserState }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after anything in the state changes. */
    'state.changed': PurserState
  }
}
