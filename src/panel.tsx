// The Purser panel: answer agents that are waiting, see what is stored, add one by hand.
// No value ever comes back from the worker, so nothing here can show one.
import {
  atom,
  Box,
  Button,
  Callout,
  Code,
  EmptyState,
  Field,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  RelativeTime,
  Row,
  Separator,
  set,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'
import { cleanValue, nameProblem, normalizeName } from './names'
import type { AskRow, PurserState, SecretRow } from './protocol'

const state = atom<PurserState | null>(null)
/** The last thing that went wrong, in words; cleared by the next success. */
const problem = atom<string | null>(null)
const busy = atom(false)
const adding = atom(false)

// Unkeyed on purpose: a reload or a closed panel drops anything typed into a value field.
const newName = atom('')
const newValue = atom('')
const askValues = atom<Record<string, string>>({})
/** A delete waits for a second press on the same row. */
const confirmDelete = atom<string | null>(null)

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

function closeForm(): void {
  set(adding, false)
  set(newName, '')
  set(newValue, '')
}

async function saveNew(): Promise<void> {
  const name = normalizeName(read(newName))
  const value = cleanValue(read(newValue))
  if (nameProblem(name) || !value) return
  if (await act(() => plugin.request('secret.save', { name, value }))) closeForm()
}

async function answer(ask: AskRow): Promise<void> {
  const value = cleanValue(read(askValues)[ask.id] ?? '')
  if (!value) return
  if (await act(() => plugin.request('secret.save', { name: ask.name, value }))) {
    update(askValues, ({ [ask.id]: _done, ...rest }) => rest)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('state.changed', (next) => set(state, next)))
  plugin.request('state.get').then(
    (next) => set(state, next),
    (error: unknown) => set(problem, message(error))
  )
}

function AskCard({ ask }: { ask: AskRow }) {
  const value = read(askValues)[ask.id] ?? ''
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
          onSubmit={() => answer(ask)}
        />
        <Row gap="xs" justify="end">
          <Button variant="ghost" size="sm" disabled={read(busy)} onPress={() => act(() => plugin.request('ask.decline', { id: ask.id }))}>
            Decline
          </Button>
          <Button tone="accent" size="sm" disabled={!cleanValue(value) || read(busy)} onPress={() => answer(ask)}>
            Save
          </Button>
        </Row>
      </Stack>
    </Box>
  )
}

function AddForm({ names }: { names: readonly string[] }) {
  const typed = read(newName)
  const name = normalizeName(typed)
  const nameError = typed ? nameProblem(name) : null
  const replacing = !nameError && names.includes(name)
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
          <Input label="Value" labelHidden type="password" placeholder="Paste the secret" value={read(newValue)} onChange={(next) => set(newValue, next)} onSubmit={saveNew} />
        </Field>
        <Row gap="xs" justify="end">
          <Button variant="ghost" size="sm" onPress={closeForm}>
            Cancel
          </Button>
          <Button tone="accent" size="sm" disabled={!ready || read(busy)} onPress={saveNew}>
            {replacing ? 'Replace' : 'Save'}
          </Button>
        </Row>
      </Stack>
    </Box>
  )
}

function SecretItem({ secret }: { secret: SecretRow }) {
  const confirming = read(confirmDelete) === secret.name
  return (
    <Stack gap="none">
      <Row justify="between" align="center" gap="sm">
        <Text weight="medium" truncate>
          <Code>{secret.name}</Code>
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
                await act(() => plugin.request('secret.delete', { name: secret.name }))
              }}
            >
              Delete
            </Button>
          </Row>
        ) : (
          <Row gap="xs" align="center">
            <Text size="xs" muted>
              {secret.lastUsedAt ? (
                <>
                  used <RelativeTime at={secret.lastUsedAt} />
                </>
              ) : (
                <>
                  saved <RelativeTime at={secret.updatedAt} />
                </>
              )}
            </Text>
            <IconButton icon="delete" label={`Delete ${secret.name}`} variant="ghost" size="xs" onPress={() => set(confirmDelete, secret.name)} />
          </Row>
        )}
      </Row>
      {secret.short ? (
        <Text size="xs" tone="warning">
          Too short to hide if a command prints it.
        </Text>
      ) : null}
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
        <AskCard key={ask.id} ask={ask} />
      ))}

      {isAdding ? <AddForm names={current.secrets.map((secret) => secret.name)} /> : null}

      {current.secrets.length ? (
        <Stack gap="sm">
          {current.asks.length || isAdding ? <Separator /> : null}
          {current.secrets.map((secret) => (
            <SecretItem key={secret.name} secret={secret} />
          ))}
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
