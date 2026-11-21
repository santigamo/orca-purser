// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// No request ever answers with a secret's value: the panel can write one, nothing reads it back.

/** One stored secret, as the panel lists it. */
export type SecretRow = {
  name: string
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
  /** Whether the local socket the `purser` command talks to is up. */
  serving: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'state.get': { output: PurserState }
    'secret.save': { input: { name: string; value: string }; output: PurserState }
    'secret.delete': { input: { name: string }; output: PurserState }
    'ask.decline': { input: { id: string }; output: PurserState }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after anything in the state changes. */
    'state.changed': PurserState
  }
}
