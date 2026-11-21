// The Purser panel: paste secrets in, answer agents that are waiting, choose what new agents get.
// No value ever comes back from the worker, so nothing here can show one.
import {
  atom,
  Badge,
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
  Separator,
  set,
  Stack,
  Switch,
  Text,
  update,
  type PanelContext
} from 'orca'
import { cleanValue, isAgentLogin, nameProblem, normalizeName } from './names'
import type { AskRow, PurserState, SecretRow } from './protocol'

const state = atom<PurserState | null>(null)
/** The last thing that went wrong, in words; cleared by the next success. */
const problem = atom<string | null>(null)
const busy = atom(false)

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

async function saveNew(): Promise<void> {
  const name = normalizeName(read(newName))
  const value = cleanValue(read(newValue))
  if (nameProblem(name) || !value) return
  if (await act(() => plugin.request('secret.save', { name, value }))) {
    set(newName, '')
    set(newValue, '')
  }
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
        <Row justify="between" align="center">
          <Text weight="semibold">
            <Code>{ask.name}</Code>
          </Text>
          <RelativeTime at={ask.at} muted />
        </Row>
        <Text size="sm">{`${ask.from} is waiting for it${ask.reason ? `: ${ask.reason}` : '.'}`}</Text>
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
          <Button tone="accent" size="sm" icon="check" disabled={!cleanValue(value) || read(busy)} onPress={() => answer(ask)}>
            Save and continue
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
    <Stack gap="sm">
      <Field
        label="Name"
        error={nameError ?? undefined}
        description={
          replacing
            ? `${name} is stored already: saving replaces its value.`
            : typed && name !== typed
              ? `Saved as ${name}`
              : 'The variable name your tools expect, such as STRIPE_API_KEY.'
        }
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
          onSubmit={saveNew}
        />
      </Field>
      <Row justify="end">
        <Button tone="accent" icon="add" disabled={!ready || read(busy)} onPress={saveNew}>
          {replacing ? 'Replace' : 'Save'}
        </Button>
      </Row>
    </Stack>
  )
}

function SecretItem({ secret }: { secret: SecretRow }) {
  const confirming = read(confirmDelete) === secret.name
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text weight="medium" truncate>
          <Code>{secret.name}</Code>
        </Text>
        <Row gap="xs" align="center">
          {confirming ? (
            <>
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
            </>
          ) : (
            <IconButton icon="delete" label={`Delete ${secret.name}`} variant="ghost" size="xs" onPress={() => set(confirmDelete, secret.name)} />
          )}
        </Row>
      </Row>
      <Text size="xs" muted>
        {secret.lastUsedAt ? (
          <>
            Used <RelativeTime at={secret.lastUsedAt} />
          </>
        ) : (
          <>
            Saved <RelativeTime at={secret.updatedAt} />, not used yet
          </>
        )}
      </Text>
      {secret.short ? (
        <Text size="xs" tone="warning">
          Too short to hide if a command prints it.
        </Text>
      ) : null}
      <Switch
        label="Give to every new agent"
        checked={secret.exported}
        disabled={read(busy)}
        onChange={(exported) => act(() => plugin.request('secret.export', { name: secret.name, exported }))}
      />
      {secret.exported && isAgentLogin(secret.name) ? (
        <Text size="xs" tone="warning">
          Agents read {secret.name} to log in: with it set they may bill this key instead of your subscription.
        </Text>
      ) : null}
    </Stack>
  )
}

function SetupSection({ current }: { current: PurserState }) {
  const pending = current.setup.filter((item) => item.state !== 'installed')
  const anyInstalled = current.setup.some((item) => item.state !== 'missing')
  return (
    <Collapsible
      title="Agent setup"
      description={pending.length ? `${pending.length} to install` : 'Claude Code and Codex know how to use Purser'}
      defaultOpen={pending.length > 0}
    >
      <Stack gap="sm">
        <Text size="sm" muted>
          A <Code>purser</Code> command and a skill that teaches agents to ask here instead of in the chat.
        </Text>
        {current.setup.map((item) => (
          <Row key={item.id} justify="between" align="center" gap="sm">
            <Stack gap="none">
              <Text size="sm">{item.label}</Text>
              <Text size="xs" muted truncate>
                {item.path.replace(/^\/(Users|home)\/[^/]+/, '~')}
              </Text>
            </Stack>
            <Badge tone={item.state === 'installed' ? 'success' : item.state === 'outdated' ? 'warning' : 'neutral'}>
              {item.state === 'installed' ? 'Installed' : item.state === 'outdated' ? 'Outdated' : 'Not installed'}
            </Badge>
          </Row>
        ))}
        <Row gap="xs" justify="end">
          {anyInstalled ? (
            <Button variant="ghost" size="sm" disabled={read(busy)} onPress={() => act(() => plugin.request('setup.remove'))}>
              Remove
            </Button>
          ) : null}
          <Button size="sm" icon="download" disabled={!pending.length || read(busy)} onPress={() => act(() => plugin.request('setup.install'))}>
            {anyInstalled && pending.length ? 'Update' : 'Install'}
          </Button>
        </Row>
      </Stack>
    </Collapsible>
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
  const names = current.secrets.map((secret) => secret.name)
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Purser</Heading>
        <Badge tone={current.protection === 'os-keyring' ? 'success' : 'danger'}>
          {current.protection === 'os-keyring' ? 'Encrypted' : 'No key store'}
        </Badge>
      </Row>

      {current.protection === 'unavailable' ? (
        <Callout tone="danger" title="Secrets cannot be saved here" icon="warning">
          <Text size="sm">This machine has no OS key store for Orca to encrypt them with.</Text>
        </Callout>
      ) : null}
      {!current.serving ? (
        <Callout tone="warning" title="The purser command cannot reach this panel" icon="warning">
          <Text size="sm">Another Orca window may be serving it. Restart the plugin from Settings → Plugins if agents report it unreachable.</Text>
        </Callout>
      ) : null}
      {error ? (
        <Callout tone="danger" icon="error">
          <Text size="sm">{error}</Text>
        </Callout>
      ) : null}

      {current.asks.length ? (
        <Stack gap="sm">
          <Text weight="semibold" tone="warning">
            Waiting for you
          </Text>
          {current.asks.map((ask) => (
            <AskCard key={ask.id} ask={ask} />
          ))}
        </Stack>
      ) : null}

      <AddForm names={names} />
      <Separator />

      {current.secrets.length ? (
        <Stack gap="md">
          {current.secrets.map((secret) => (
            <SecretItem key={secret.name} secret={secret} />
          ))}
        </Stack>
      ) : (
        <EmptyState
          icon="package"
          title="No secrets yet"
          description="Paste one above, or let an agent ask: it runs purser need NAME and the request shows up here."
        />
      )}

      <Separator />
      <SetupSection current={current} />
    </Stack>
  )
}
