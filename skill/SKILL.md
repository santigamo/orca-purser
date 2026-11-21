---
name: purser
description: Use an API key, token, password or other credential without seeing it. Use whenever a command needs a secret, when you would otherwise ask the person to paste a key into the chat or into a file, or when a call fails because a credential is missing. Purser keeps secrets in Orca and runs commands with them filled in.
---

# Purser

The person stores secrets in Orca's Purser panel. You use them by name with the `purser`
command and never see their values. If `purser` is not on PATH, use `"$PURSER_CLI"` or
`~/.purser/bin/purser`.

## Use a secret

```
purser list
purser run -- curl -H "Authorization: Bearer {{STRIPE_API_KEY}}" https://api.stripe.com/v1/balance
```

Inside `purser run`, `{{NAME}}` in any argument becomes the value, and every stored secret is
also in the command's environment as `$NAME`. Your own shell does not have those variables, so
`$NAME` outside single quotes expands to nothing before Purser runs:

```
purser run -- sh -c 'psql "$DATABASE_URL" -c "select 1"'    # right: single quotes
purser run -- psql "$DATABASE_URL" -c "select 1"            # wrong: empty before purser starts
```

`--only A,B` passes just those secrets. Values that appear in the output are shown as
`[purser:NAME]`; that means the command worked with the real value.

## A secret is missing

Ask for it. The person gets a masked field in Orca and you get the answer when they paste:

```
purser need STRIPE_API_KEY "to read the test account balance"
```

- Exit 0: stored, go on.
- Exit 75: still waiting. Tell the person it is waiting in the Purser panel, then run the same
  command again.
- Exit 77: declined. Do not ask again; say what you could not do.

Name it the way the tool expects (`OPENAI_API_KEY`, `GH_TOKEN`, `DATABASE_URL`).

## Rules

- Never ask the person to paste a secret into the chat, and never write one into a file,
  a commit, a command line of your own or a config. If a file needs one, have the program
  read it from the environment and start it with `purser run`.
- Never print, echo, encode or otherwise reveal a value, and do not work around `[purser:NAME]`.
- If `purser` cannot reach Orca from a sandboxed command, run that command outside the sandbox.
