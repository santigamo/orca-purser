// Where secrets live: values in Orca's encrypted secrets file (the OS key store protects it),
// everything else about them in the plugin's storage. Values are never written anywhere else.
//
// A secret is global (usable everywhere) or belongs to one project. In a project, its own
// secrets win over global ones of the same name, so STRIPE_API_KEY can differ per client.
import { createHash } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { MIN_REDACT_LENGTH } from './names'
import type { Project, SecretRow } from './protocol'

type Meta = Omit<SecretRow, 'id' | 'storageKey'>

const INDEX = 'index'

/** Global secrets keep their bare name as id, as 0.1.0 stored them. */
export function secretId(name: string, project: Project | null): string {
  if (!project) return name
  const hash = createHash('sha256').update(project.key).digest('hex').slice(0, 16)
  return `p:${hash}:${name}`
}

const storageKey = (id: string): string => `secret:${id}`

export class Store {
  private index: Record<string, Meta> = {}
  /** Values read so far, so a busy `purser run` loop does not hit the key store each time. */
  private readonly cache = new Map<string, string>()
  private readonly loading: Promise<void>

  constructor(private readonly orca: OrcaWorkerApi) {
    this.loading = this.load()
  }

  private async load(): Promise<void> {
    const stored = await this.orca.storage.get(INDEX)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return
    for (const [id, raw] of Object.entries(stored as Record<string, Record<string, unknown>>)) {
      // 0.1.0 rows: keyed by name, no `name` or `project`, maybe an `exported` flag.
      const { exported: _dropped, ...row } = raw
      this.index[id] = {
        name: typeof row.name === 'string' ? row.name : id,
        project: (row.project as Project | null | undefined) ?? null,
        createdAt: Number(row.createdAt) || Date.now(),
        updatedAt: Number(row.updatedAt) || Date.now(),
        lastUsedAt: typeof row.lastUsedAt === 'number' ? row.lastUsedAt : null,
        short: row.short === true
      }
    }
  }

  ready(): Promise<void> {
    return this.loading
  }

  /** Every name stored anywhere, sorted, once each. */
  names(): string[] {
    return [...new Set(Object.values(this.index).map((meta) => meta.name))].sort()
  }

  rows(): SecretRow[] {
    return Object.entries(this.index)
      .map(([id, meta]) => ({ id, storageKey: storageKey(id), ...meta }))
      .sort((a, b) => (a.project?.name ?? '').localeCompare(b.project?.name ?? '') || a.name.localeCompare(b.name))
  }

  /** The id `name` resolves to in `project`: its own secret, else the global one. */
  resolve(name: string, project: Project | null): string | null {
    const own = project ? secretId(name, project) : null
    if (own && this.index[own]) return own
    return this.index[name] && this.index[name].project === null ? name : null
  }

  /** The rows an agent in `project` can use, its own ones replacing global ones by name. */
  visible(project: Project | null): SecretRow[] {
    const byName = new Map<string, SecretRow>()
    for (const row of this.rows()) {
      if (row.project && row.project.key !== project?.key) continue
      const current = byName.get(row.name)
      if (!current || (row.project && !current.project)) byName.set(row.name, row)
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async save(name: string, project: Project | null, value: string): Promise<string> {
    await this.loading
    const id = secretId(name, project)
    await this.orca.secrets.set(storageKey(id), value)
    this.cache.set(id, value)
    const now = Date.now()
    const previous = this.index[id]
    this.index[id] = {
      name,
      project,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: previous?.lastUsedAt ?? null,
      short: value.length < MIN_REDACT_LENGTH
    }
    await this.writeIndex()
    return id
  }

  /** A new value, a new place, or both. Moving onto a secret that already exists is refused. */
  async update(id: string, change: { value?: string; project?: Project | null }): Promise<string> {
    await this.loading
    const meta = this.index[id]
    if (!meta) throw new Error('That secret is no longer stored.')
    const project = change.project === undefined ? meta.project : change.project
    const nextId = secretId(meta.name, project)
    if (nextId !== id && this.index[nextId]) {
      throw new Error(`${meta.name} is already stored ${project ? `in ${project.name}` : 'for all projects'}. Delete that one first.`)
    }
    const value = change.value ?? (await this.value(id))
    if (value === null) throw new Error('The stored value could not be read.')
    await this.orca.secrets.set(storageKey(nextId), value)
    this.cache.set(nextId, value)
    const now = Date.now()
    this.index[nextId] = {
      ...meta,
      project,
      updatedAt: change.value === undefined ? meta.updatedAt : now,
      short: value.length < MIN_REDACT_LENGTH
    }
    if (nextId !== id) {
      delete this.index[id]
      this.cache.delete(id)
      await this.orca.secrets.delete(storageKey(id))
    }
    await this.writeIndex()
    return nextId
  }

  async delete(id: string): Promise<void> {
    await this.loading
    await this.orca.secrets.delete(storageKey(id))
    this.cache.delete(id)
    delete this.index[id]
    await this.writeIndex()
  }

  private async value(id: string): Promise<string | null> {
    if (!this.index[id]) return null
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached
    const value = await this.orca.secrets.get(storageKey(id))
    if (value !== null) this.cache.set(id, value)
    return value
  }

  /** The values `project` sees for `names` (all it can see when omitted), and the ones missing. */
  async valuesFor(
    project: Project | null,
    names?: readonly string[]
  ): Promise<{ values: Record<string, string>; missing: string[]; ids: string[] }> {
    await this.loading
    const values: Record<string, string> = {}
    const missing: string[] = []
    const ids: string[] = []
    for (const name of names ?? this.visible(project).map((row) => row.name)) {
      const id = this.resolve(name, project)
      const value = id ? await this.value(id) : null
      if (id && value !== null) {
        values[name] = value
        ids.push(id)
      } else {
        missing.push(name)
      }
    }
    return { values, missing, ids }
  }

  async markUsed(ids: readonly string[]): Promise<void> {
    const now = Date.now()
    let changed = false
    for (const id of ids) {
      if (!this.index[id]) continue
      this.index[id] = { ...this.index[id], lastUsedAt: now }
      changed = true
    }
    if (changed) await this.writeIndex()
  }

  private async writeIndex(): Promise<void> {
    await this.orca.storage.set(INDEX, this.index)
  }
}
