// The Purser panel: answer agents that are waiting, see what is stored per project, add, edit,
// show for a moment, delete. The worker never sends a value: "Show" reads it here, straight from
// the plugin's encrypted secrets, and forgets it after a few seconds.
import {
  atom,
  Box,
  Button,
  Callout,
  Code,
  Collapsible,
  EmptyState,
  Field,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  RelativeTime,
  Row,
  secrets,
  Select,
  Separator,
  set,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'
import { cleanValue, nameProblem, normalizeName } from './names'
import type { AskRow, Project, PurserState, SecretRow } from './protocol'

/** How long a shown value stays on screen. */
export const SHOW_SECONDS = 10
const GLOBAL = '__global__'

const state = atom<PurserState | null>(null)
/** The last thing that went wrong, in words; cleared by the next success. */
const problem = atom<string | null>(null)
const busy = atom(false)

// Unkeyed on purpose: a reload or a closed panel drops anything typed or shown.
const adding = atom(false)
const newName = atom('')
const newValue = atom('')
const newScope = atom<string | null>(null)
const askValues = atom<Record<string, string>>({})
const askScopes = atom<Record<string, string>>({})
const editing = atom<{ id: string; value: string; scope: string } | null>(null)
const shown = atom<{ id: string; value: string } | null>(null)
/** A delete waits for a second press on the same row. */
const confirmDelete = atom<string | null>(null)

let hideTimer: ReturnType<typeof setTimeout> | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function act(run: () => Promise<PurserState>): Promise<boolean> {
  set(busy, true)
  try {
    set(state, await run())
    set(problem, null)
    return true
  } catch (error) {
    set(problem, message(error))
    return false
  } finally {
    set(busy, false)
  }
}

// --- Projects --------------------------------------------------------------------------------

/** Every project the panel knows of: the focused one, those asked from, those with secrets. */
function knownProjects(current: PurserState): Project[] {
  const byKey = new Map<string, Project>()
  const add = (project: Project | null): void => {
    if (project && !byKey.has(project.key)) byKey.set(project.key, project)
  }
  add(current.currentProject)
  for (const ask of current.asks) add(ask.project)
  for (const row of current.secrets) add(row.project)
  return [...byKey.values()]
}

const scopeOf = (project: Project | null): string => project?.key ?? GLOBAL

function projectFor(scope: string, current: PurserState): Project | null {
  return scope === GLOBAL ? null : (knownProjects(current).find((project) => project.key === scope) ?? null)
}

/** "Only this project" first when there is one, then every project, then all of them. */
function scopeOptions(current: PurserState, preferred: Project | null) {
  const projects = knownProjects(current)
  const ordered = preferred ? [preferred, ...projects.filter((project) => project.key !== preferred.key)] : projects
  return [
    ...ordered.map((project) => ({ value: project.key, label: `Only ${project.name}` })),
    { value: GLOBAL, label: 'All projects' }
  ]
}

// --- Actions ---------------------------------------------------------------------------------

function closeForm(): void {
  set(adding, false)
  set(newName, '')
  set(newValue, '')
  set(newScope, null)
}

async function saveNew(current: PurserState): Promise<void> {
  const name = normalizeName(read(newName))
  const value = cleanValue(read(newValue))
  if (nameProblem(name) || !value) return
  const project = projectFor(read(newScope) ?? scopeOf(current.currentProject), current)
  if (await act(() => plugin.request('secret.save', { name, value, project }))) closeForm()
}

async function answer(ask: AskRow, current: PurserState): Promise<void> {
  const value = cleanValue(read(askValues)[ask.id] ?? '')
  if (!value) return
  const project = projectFor(read(askScopes)[ask.id] ?? scopeOf(ask.project), current)
  if (await act(() => plugin.request('secret.save', { name: ask.name, value, project }))) {
    update(askValues, ({ [ask.id]: _done, ...rest }) => rest)
  }
}

async function saveEdit(row: SecretRow, current: PurserState): Promise<void> {
  const draft = read(editing)
  if (!draft) return
  const value = cleanValue(draft.value)
  const project = projectFor(draft.scope, current)
  const moved = scopeOf(project) !== scopeOf(row.project)
  if (!value && !moved) {
    set(editing, null)
    return
  }
  const change = { id: row.id, ...(value ? { value } : {}), ...(moved ? { project } : {}) }
  if (await act(() => plugin.request('secret.update', change))) set(editing, null)
}

function hide(): void {
  clearTimeout(hideTimer)
  set(shown, null)
}

async function show(row: SecretRow): Promise<void> {
  hide()
  try {
    const value = await secrets.get(row.storageKey)
    if (value === null) {
      set(problem, `${row.name} has no stored value.`)
      return
    }
    set(shown, { id: row.id, value })
    hideTimer = setTimeout(hide, SHOW_SECONDS * 1000)
  } catch (error) {
    set(problem, message(error))
  }
}

export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(plugin.on('state.changed', (next) => set(state, next)))
  plugin.request('state.get').then(
    (next) => set(state, next),
    (error: unknown) => set(problem, message(error))
  )
  return () => clearTimeout(hideTimer)
}

// --- Pieces ----------------------------------------------------------------------------------

function AskCard({ ask, current }: { ask: AskRow; current: PurserState }) {
  const value = read(askValues)[ask.id] ?? ''
  const scope = read(askScopes)[ask.id] ?? scopeOf(ask.project)
  return (
    <Box border="warning" radius="md" padding="sm" background="card">
      <Stack gap="sm">
        <Text size="sm">{`${ask.from} is waiting for`}</Text>
        <Text weight="semibold">
          <Code>{ask.name}</Code>
        </Text>
        {ask.reason ? (
          <Text size="sm" muted>
            {ask.reason}
          </Text>
        ) : null}
        <Input
          label={`Value for ${ask.name}`}
          labelHidden
          type="password"
          placeholder="Paste it here"
          value={value}
          onChange={(next) => update(askValues, (all) => ({ ...all, [ask.id]: next }))}
          onSubmit={() => answer(ask, current)}
        />
        <Select
          label={`Where to use ${ask.name}`}
          labelHidden
          value={scope}
          options={scopeOptions(current, ask.project)}
          onChange={(next) => update(askScopes, (all) => ({ ...all, [ask.id]: next }))}
        />
        <Row gap="xs" justify="end">
          <Button variant="ghost" size="sm" disabled={read(busy)} onPress={() => act(() => plugin.request('ask.decline', { id: ask.id }))}>
            Decline
          </Button>
          <Button tone="accent" size="sm" disabled={!cleanValue(value) || read(busy)} onPress={() => answer(ask, current)}>
            Save
          </Button>
        </Row>
      </Stack>
    </Box>
  )
}

function AddForm({ current }: { current: PurserState }) {
  const typed = read(newName)
  const name = normalizeName(typed)
  const nameError = typed ? nameProblem(name) : null
  const scope = read(newScope) ?? scopeOf(current.currentProject)
  const replacing = !nameError && current.secrets.some((row) => row.name === name && scopeOf(row.project) === scope)
  const ready = Boolean(name) && !nameError && Boolean(cleanValue(read(newValue)))
  return (
    <Box border radius="md" padding="sm">
      <Stack gap="sm">
        <Field
          label="Name"
          error={nameError ?? undefined}
          description={replacing ? `Replaces the stored ${name}.` : typed && name !== typed ? `Saved as ${name}` : undefined}
        >
          <Input label="Name" labelHidden placeholder="STRIPE_API_KEY" value={typed} invalid={Boolean(nameError)} onChange={(next) => set(newName, next)} />
        </Field>
        <Field label="Value">
          <Input
            label="Value"
            labelHidden
            type="password"
            placeholder="Paste the secret"
            value={read(newValue)}
            onChange={(next) => set(newValue, next)}
            onSubmit={() => saveNew(current)}
          />
        </Field>
        <Select label="Use in" value={scope} options={scopeOptions(current, current.currentProject)} onChange={(next) => set(newScope, next)} />
        <Row gap="xs" justify="end">
          <Button variant="ghost" size="sm" onPress={closeForm}>
            Cancel
          </Button>
          <Button tone="accent" size="sm" disabled={!ready || read(busy)} onPress={() => saveNew(current)}>
            {replacing ? 'Replace' : 'Save'}
          </Button>
        </Row>
      </Stack>
    </Box>
  )
}

function EditForm({ row, current }: { row: SecretRow; current: PurserState }) {
  const draft = read(editing)
  if (!draft) return null
  return (
    <Box border radius="md" padding="sm">
      <Stack gap="sm">
        <Field label="New value" description="Leave it empty to keep the current one.">
          <Input
            label="New value"
            labelHidden
            type="password"
            placeholder="Paste the new value"
            value={draft.value}
            onChange={(value) => set(editing, { ...draft, value })}
            onSubmit={() => saveEdit(row, current)}
          />
        </Field>
        <Select
          label="Use in"
          value={draft.scope}
          options={scopeOptions(current, row.project ?? current.currentProject)}
          onChange={(scope) => set(editing, { ...draft, scope })}
        />
        <Row gap="xs" justify="end">
          <Button variant="ghost" size="sm" onPress={() => set(editing, null)}>
            Cancel
          </Button>
          <Button tone="accent" size="sm" disabled={read(busy)} onPress={() => saveEdit(row, current)}>
            Save
          </Button>
        </Row>
      </Stack>
    </Box>
  )
}

function SecretItem({ row, current, shadowed }: { row: SecretRow; current: PurserState; shadowed: boolean }) {
  const confirming = read(confirmDelete) === row.id
  const isEditing = read(editing)?.id === row.id
  const visible = read(shown)
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm">
        <Text weight="medium" truncate>
          <Code>{row.name}</Code>
        </Text>
        {confirming ? (
          <Row gap="xs">
            <Button size="xs" variant="ghost" onPress={() => set(confirmDelete, null)}>
              Keep
            </Button>
            <Button
              size="xs"
              tone="danger"
              onPress={async () => {
                set(confirmDelete, null)
                await act(() => plugin.request('secret.delete', { id: row.id }))
              }}
            >
              Delete
            </Button>
          </Row>
        ) : (
          <Row gap="none" align="center">
            <Button size="xs" variant="ghost" onPress={() => (visible?.id === row.id ? hide() : show(row))}>
              {visible?.id === row.id ? 'Hide' : 'Show'}
            </Button>
            <IconButton
              icon="edit"
              label={`Edit ${row.name}`}
              variant="ghost"
              size="xs"
              onPress={() => set(editing, isEditing ? null : { id: row.id, value: '', scope: scopeOf(row.project) })}
            />
            <IconButton icon="delete" label={`Delete ${row.name}`} variant="ghost" size="xs" onPress={() => set(confirmDelete, row.id)} />
          </Row>
        )}
      </Row>
      <Text size="xs" muted>
        {row.lastUsedAt ? (
          <>
            Used <RelativeTime at={row.lastUsedAt} />
          </>
        ) : (
          <>
            Saved <RelativeTime at={row.updatedAt} />, not used yet
          </>
        )}
        {shadowed ? ' · this project uses its own' : ''}
      </Text>
      {row.short ? (
        <Text size="xs" tone="warning">
          Too short to hide if a command prints it.
        </Text>
      ) : null}
      {visible?.id === row.id ? (
        <Stack gap="xs">
          <Code block>{visible.value}</Code>
          <Text size="xs" muted>{`Hides in ${SHOW_SECONDS} seconds.`}</Text>
        </Stack>
      ) : null}
      {isEditing ? <EditForm row={row} current={current} /> : null}
    </Stack>
  )
}

function Group({ title, rows, current }: { title: string; rows: SecretRow[]; current: PurserState }) {
  if (!rows.length) return null
  const own = new Set(
    current.currentProject ? current.secrets.filter((row) => row.project?.key === current.currentProject?.key).map((row) => row.name) : []
  )
  return (
    <Stack gap="sm">
      <Text size="xs" weight="semibold" muted>
        {title}
      </Text>
      {rows.map((row) => (
        <SecretItem key={row.id} row={row} current={current} shadowed={!row.project && own.has(row.name)} />
      ))}
    </Stack>
  )
}

function SecretList({ current }: { current: PurserState }) {
  const here = current.currentProject
  const global = current.secrets.filter((row) => !row.project)
  const others = knownProjects(current)
    .filter((project) => project.key !== here?.key)
    .map((project) => ({ project, rows: current.secrets.filter((row) => row.project?.key === project.key) }))
    .filter((group) => group.rows.length)
  const otherGroups = others.map(({ project, rows }) => <Group key={project.key} title={project.name} rows={rows} current={current} />)
  return (
    <Stack gap="md">
      {here ? <Group title={`This project · ${here.name}`} rows={current.secrets.filter((row) => row.project?.key === here.key)} current={current} /> : null}
      <Group title="All projects" rows={global} current={current} />
      {here && others.length ? (
        <Collapsible title={`Other projects (${others.length})`}>
          <Stack gap="md">{otherGroups}</Stack>
        </Collapsible>
      ) : (
        otherGroups
      )}
    </Stack>
  )
}

export default function Panel() {
  const current = read(state)
  const error = read(problem)
  if (!current) {
    return error ? (
      <Callout tone="danger" title="Purser did not start" icon="error">
        <Text size="sm">{error}</Text>
      </Callout>
    ) : (
      <Text muted>Loading…</Text>
    )
  }
  const isAdding = read(adding)
  const canStore = current.protection !== 'unavailable'
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Purser</Heading>
        {canStore ? (
          <IconButton
            icon={isAdding ? 'close' : 'add'}
            label={isAdding ? 'Cancel' : 'Add a secret'}
            tooltip={isAdding ? 'Cancel' : 'Add a secret'}
            variant="ghost"
            onPress={() => (isAdding ? closeForm() : set(adding, true))}
          />
        ) : null}
      </Row>

      {!canStore ? (
        <Callout tone="danger" title="Secrets cannot be saved here" icon="warning">
          <Text size="sm">This machine has no OS key store for Orca to encrypt them with.</Text>
        </Callout>
      ) : null}
      {!current.serving ? (
        <Callout tone="warning" title="Agents cannot reach Purser" icon="warning">
          <Text size="sm">Restart the plugin from Settings → Plugins.</Text>
        </Callout>
      ) : null}
      {error ? (
        <Callout tone="danger" icon="error">
          <Text size="sm">{error}</Text>
        </Callout>
      ) : null}

      {current.asks.map((ask) => (
        <AskCard key={ask.id} ask={ask} current={current} />
      ))}

      {isAdding ? <AddForm current={current} /> : null}

      {current.secrets.length ? (
        <Stack gap="sm">
          {current.asks.length || isAdding ? <Separator /> : null}
          <SecretList current={current} />
        </Stack>
      ) : !current.asks.length && !isAdding ? (
        <EmptyState
          icon="package"
          title="No secrets yet"
          description="When an agent needs an API key, it asks here and you paste it. Agents use it by name and never see the value."
        >
          {canStore ? (
            <Button size="sm" icon="add" onPress={() => set(adding, true)}>
              Add one now
            </Button>
          ) : null}
        </EmptyState>
      ) : null}
    </Stack>
  )
}
