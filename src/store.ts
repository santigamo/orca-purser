// Where secrets live: values in Orca's encrypted secrets file (the OS key store protects it),
// everything else about them in the plugin's storage. Values are never written anywhere else.
import type { OrcaWorkerApi } from 'orca/worker'
import { MIN_REDACT_LENGTH } from './names'
import type { SecretRow } from './protocol'

type Meta = Omit<SecretRow, 'name'>

const INDEX = 'index'
const secretKey = (name: string): string => `secret:${name}`

export class Store {
  private index: Record<string, Meta> = {}
  /** Values read so far. Hooks have 2 s to answer, so they must not wait on the key store. */
  private readonly cache = new Map<string, string>()
  private readonly loading: Promise<void>

  constructor(private readonly orca: OrcaWorkerApi) {
    this.loading = this.load()
  }

  private async load(): Promise<void> {
    const stored = await this.orca.storage.get(INDEX)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      this.index = stored as unknown as Record<string, Meta>
    }
    // Exported values are needed inside the launch hook: read them ahead of the first launch.
    await Promise.all(
      this.names()
        .filter((name) => this.index[name].exported)
        .map((name) => this.value(name).catch(() => null))
    )
  }

  ready(): Promise<void> {
    return this.loading
  }

  /** Sorted names; empty until `ready()`. */
  names(): string[] {
    return Object.keys(this.index).sort()
  }

  has(name: string): boolean {
    return Object.hasOwn(this.index, name)
  }

  isExported(name: string): boolean {
    return this.index[name]?.exported === true
  }

  rows(): SecretRow[] {
    return this.names().map((name) => ({ name, ...this.index[name] }))
  }

  async save(name: string, value: string): Promise<void> {
    await this.loading
    await this.orca.secrets.set(secretKey(name), value)
    this.cache.set(name, value)
    const now = Date.now()
    const previous = this.index[name]
    this.index[name] = {
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: previous?.lastUsedAt ?? null,
      exported: previous?.exported ?? false,
      short: value.length < MIN_REDACT_LENGTH
    }
    await this.writeIndex()
  }

  async delete(name: string): Promise<void> {
    await this.loading
    await this.orca.secrets.delete(secretKey(name))
    this.cache.delete(name)
    delete this.index[name]
    await this.writeIndex()
  }

  async setExported(name: string, exported: boolean): Promise<void> {
    await this.loading
    if (!this.has(name)) return
    if (exported) await this.value(name)
    this.index[name] = { ...this.index[name], exported }
    await this.writeIndex()
  }

  async value(name: string): Promise<string | null> {
    if (!this.has(name)) return null
    const cached = this.cache.get(name)
    if (cached !== undefined) return cached
    const value = await this.orca.secrets.get(secretKey(name))
    if (value !== null) this.cache.set(name, value)
    return value
  }

  /** The values of `names` (all when omitted) and which of them are not stored. */
  async valuesOf(names?: readonly string[]): Promise<{ values: Record<string, string>; missing: string[] }> {
    await this.loading
    const values: Record<string, string> = {}
    const missing: string[] = []
    for (const name of names ?? this.names()) {
      const value = await this.value(name)
      if (value === null) missing.push(name)
      else values[name] = value
    }
    return { values, missing }
  }

  /** What the launch hook adds to an agent's environment. Reads memory only. */
  exportedValues(): Record<string, string> {
    const values: Record<string, string> = {}
    for (const name of this.names()) {
      const value = this.cache.get(name)
      if (this.index[name].exported && value !== undefined) values[name] = value
    }
    return values
  }

  async markUsed(names: readonly string[]): Promise<void> {
    const now = Date.now()
    let changed = false
    for (const name of names) {
      if (!this.has(name)) continue
      this.index[name] = { ...this.index[name], lastUsedAt: now }
      changed = true
    }
    if (changed) await this.writeIndex()
  }

  private async writeIndex(): Promise<void> {
    await this.orca.storage.set(INDEX, this.index)
  }
}
