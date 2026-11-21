# Purser

Stop pasting API keys into the chat. Purser is an Orca plugin: you paste secrets into a masked
field in Orca's sidebar, and your agents (Claude Code, Codex, any CLI) use them by name without
ever seeing the values.

```
agent:  purser need STRIPE_API_KEY "to read the test balance"
you:    (Orca notifies you; paste the key in the Purser panel)
agent:  purser run -- curl -H "Authorization: Bearer {{STRIPE_API_KEY}}" https://api.stripe.com/v1/balance
        → output shows [purser:STRIPE_API_KEY] wherever the value would appear
```

## How it works

- **Storage.** Values live in Orca's encrypted plugin secrets, protected by your OS key store
  (macOS Keychain, libsecret, DPAPI). Names and timestamps live in plugin storage. No request to
  the plugin ever returns a value to the panel.
- **The `purser` command** talks to the plugin over a Unix socket in `~/.purser` (folder `0700`,
  socket `0600`). `run` fills `{{NAME}}` in arguments, puts every secret in the child's
  environment, and replaces values (plain, base64, hex, URL-encoded) in its output.
- **Asking.** `purser need NAME` shows a card in the panel and a desktop notification, then waits
  up to 90 s. If you take longer the ask stays open and the agent is told to run it again.
- **Hooks.** `agent.launch.before` gives each new agent `$PURSER_CLI`, plus any secret you mark
  "Give to every new agent". `agent.tool.before` stops a Claude Code Bash call that reads
  `$NAME` its shell does not have, and tells it how to use `purser run` instead.
- **Setup.** One button in the panel installs the `purser` command into `~/.local/bin` and a
  skill into `~/.claude/skills` and `~/.agents/skills` (Codex). Remove undoes it.

## What it does not protect against

Purser keeps secrets out of the chat, the transcript and the screen. It is not a sandbox: an
agent running as your user can still run `purser run -- printenv` and transform the output
in ways the filter does not catch. Exported secrets are in the agent's environment. Treat it as
protection against accidents, not against a hostile agent.

## Develop

```
npm install
npm run check          # validate, type-check, test, render the panel
orca plugin dev watch . --check --json
```

Tests run against a temporary home (`PURSER_HOME_DIR`), never the real `~/.purser`.

MIT licensed.
