#!/usr/bin/env node
// The `purser` command: how an agent (or you) uses a stored secret without reading it.
// It talks to the Purser plugin running inside Orca over a local socket. Plain Node, no
// dependencies, so it runs wherever an agent's shell does.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

/** Values shorter than this are not searched for in output: too likely to match by chance. */
const MIN_REDACT_LENGTH = 6
/** Shorter than the two minutes most agents give one command, so the hint below gets out. */
const DEFAULT_WAIT_SECONDS = 90

const EXIT = { usage: 64, unavailable: 69, pending: 75, declined: 77, missing: 78 }

const HELP = `purser: use a stored secret without reading it

  purser list                     Names of the stored secrets (never values)
  purser run -- <command...>      Run a command with the secrets available:
                                    {{NAME}} in an argument becomes the value
                                    $NAME is in the command's environment
                                  Values that show up in its output read [purser:NAME]
  purser need NAME [why...]       Ask the person to paste NAME in Orca, and wait for it

Examples
  purser run -- curl -H "Authorization: Bearer {{STRIPE_API_KEY}}" https://api.stripe.com/v1/balance
  purser run -- sh -c 'psql "$DATABASE_URL" -c "select 1"'     (single quotes: purser expands it)
  purser run --only NPM_TOKEN -- npm publish
  purser need STRIPE_API_KEY "to read the test account balance"

Never ask the person to paste a secret in the chat: run \`purser need\` instead.
Never print, echo, encode or write a secret to a file.`

/**
 * Hides secret values in text that arrives in pieces. A value can be cut across two pieces,
 * so the last few characters wait for the next piece before they go out.
 */
export function createRedactor(values) {
  const needles = []
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.length < MIN_REDACT_LENGTH) continue
    const mark = `[purser:${name}]`
    const bytes = Buffer.from(value, 'utf8')
    for (const form of new Set([
      value,
      encodeURIComponent(value),
      bytes.toString('base64'),
      bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('base64url'),
      bytes.toString('hex')
    ])) {
      if (form.length >= MIN_REDACT_LENGTH) needles.push([form, mark])
    }
  }
  // Longest first, so a value that contains another is replaced whole.
  needles.sort((a, b) => b[0].length - a[0].length)
  const hold = needles.length ? needles[0][0].length - 1 : 0
  let pending = ''
  const scrub = (text) => {
    let out = text
    for (const [needle, mark] of needles) out = out.split(needle).join(mark)
    return out
  }
  return {
    /** Text safe to show now. */
    push(text) {
      pending = scrub(pending + text)
      const keep = Math.min(hold, pending.length)
      const out = pending.slice(0, pending.length - keep)
      pending = pending.slice(pending.length - keep)
      return out
    },
    /** Whatever was held back. Call when the stream ends or goes quiet. */
    flush() {
      const out = scrub(pending)
      pending = ''
      return out
    }
  }
}

/** Replaces {{NAME}} in each argument; `missing` lists names that are not stored. */
export function substitute(args, values) {
  const missing = new Set()
  const out = args.map((arg) =>
    arg.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name) => {
      if (Object.hasOwn(values, name)) return values[name]
      missing.add(name)
      return match
    })
  )
  return { args: out, missing: [...missing] }
}

/** `run [--only A,B] -- cmd ...` */
export function parseRun(argv) {
  let only
  let index = 0
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      index += 1
      break
    }
    if (arg === '--only') {
      only = (argv[index + 1] ?? '').split(',').map((name) => name.trim()).filter(Boolean)
      index += 1
    } else if (arg.startsWith('--only=')) {
      only = arg.slice(7).split(',').map((name) => name.trim()).filter(Boolean)
    } else if (arg.startsWith('-')) {
      return { error: `unknown option ${arg}` }
    } else {
      break
    }
  }
  const command = argv.slice(index)
  if (!command.length) return { error: 'nothing to run. Usage: purser run -- <command...>' }
  if (only && !only.length) return { error: '--only needs names, such as --only NPM_TOKEN,GH_TOKEN' }
  return { only, command }
}

function socketPath(env) {
  return env.PURSER_SOCK || join(env.PURSER_HOME_DIR || homedir(), '.purser', 'purser.sock')
}

class Unreachable extends Error {}

/** One request, one answer. `onOpen` gets a function that hangs up. */
function ask(request, env, onOpen) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath(env))
    let buffer = ''
    let done = false
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      onOpen?.(() => socket.destroy())
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
    })
    socket.once('error', (error) => {
      done = true
      reject(new Unreachable(error.code === 'EPERM' || error.code === 'EACCES' ? 'blocked' : 'down'))
    })
    socket.once('close', () => {
      if (done) return
      try {
        const answer = JSON.parse(buffer)
        if (answer.ok) resolve(answer)
        else reject(new Error(answer.error || 'Purser refused the request'))
      } catch {
        reject(new Unreachable('hung-up'))
      }
    })
  })
}

function explainUnreachable(error) {
  if (error.message === 'blocked') {
    return 'purser: this command runs in a sandbox that blocks Purser\'s socket. Run it again outside the sandbox (ask for approval if your agent needs it).'
  }
  if (error.message === 'hung-up') return 'purser: Purser stopped answering (Orca or the plugin restarted). Run the command again.'
  return 'purser: cannot reach Purser. It runs inside Orca: open Orca and check that the Purser plugin is enabled. In a sandboxed command, run it again outside the sandbox.'
}

/** Who is asking, for the person reading the request in Orca. */
function describeCaller(env, cwd) {
  const agent = env.CLAUDECODE ? 'Claude Code' : Object.keys(env).some((key) => key.startsWith('CODEX_')) ? 'Codex' : 'An agent'
  const folder = basename(cwd)
  return folder ? `${agent} in ${folder}` : agent
}

async function list(io) {
  const { secrets, waiting } = await ask({ op: 'list' }, io.env)
  if (!secrets.length) {
    io.out('No secrets stored. Ask for one with: purser need NAME "why you need it"\n')
  } else {
    for (const secret of secrets) {
      io.out(`${secret.name}${secret.short ? '  (too short to hide in output)' : ''}\n`)
    }
    io.out('\nUse one with: purser run -- <command with {{NAME}} or $NAME>\n')
  }
  if (waiting.length) io.out(`Waiting for the person to paste: ${waiting.join(', ')}\n`)
  return 0
}

async function need(argv, io) {
  const [name, ...why] = argv
  if (!name || name.startsWith('-')) {
    io.err('purser: which secret? Usage: purser need NAME [why you need it]\n')
    return EXIT.usage
  }
  let hangUp = () => undefined
  const seconds = Number(io.env.PURSER_WAIT_SECONDS) > 0 ? Number(io.env.PURSER_WAIT_SECONDS) : DEFAULT_WAIT_SECONDS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    hangUp()
  }, seconds * 1000)
  try {
    const answer = await ask(
      { op: 'need', name, reason: why.join(' '), from: describeCaller(io.env, io.cwd) },
      io.env,
      (close) => {
        hangUp = close
      }
    )
    const label = name.toUpperCase()
    if (answer.status === 'available') io.out(`${label} is already stored. Use it with: purser run -- <command with {{${label}}}>\n`)
    else if (answer.status === 'provided') io.out(`${label} was just stored. Use it with: purser run -- <command with {{${label}}}>\n`)
    else {
      io.err(`purser: the person declined to provide ${label}. Do not ask again; tell them what you could not do.\n`)
      return EXIT.declined
    }
    return 0
  } catch (error) {
    if (timedOut) {
      io.err(
        `purser: still waiting for the person to paste ${name.toUpperCase()} in Orca's Purser panel. ` +
          'The request stays open there. Tell them, then run the same command again to keep waiting.\n'
      )
      return EXIT.pending
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function run(argv, io) {
  const parsed = parseRun(argv)
  if (parsed.error) {
    io.err(`purser: ${parsed.error}\n`)
    return EXIT.usage
  }
  const { values, missing } = await ask({ op: 'env', names: parsed.only }, io.env)
  const substituted = substitute(parsed.command, values)
  const absent = [...new Set([...missing, ...substituted.missing])]
  if (absent.length) {
    io.err(
      `purser: not stored: ${absent.join(', ')}. Ask the person for it with: purser need ${absent[0]} "why you need it"\n`
    )
    return EXIT.missing
  }
  const [command, ...args] = substituted.args
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...io.env, ...values },
      cwd: io.cwd,
      stdio: ['inherit', 'pipe', 'pipe']
    })
    const pipe = (stream, write) => {
      const redactor = createRedactor(values)
      const decoder = new StringDecoder('utf8')
      let quiet
      stream.on('data', (chunk) => {
        clearTimeout(quiet)
        write(redactor.push(decoder.write(chunk)))
        // A prompt with no newline should not sit unseen while the tail is held back.
        quiet = setTimeout(() => write(redactor.flush()), 150)
      })
      return new Promise((done) =>
        stream.on('close', () => {
          clearTimeout(quiet)
          write(redactor.push(decoder.end()) + redactor.flush())
          done()
        })
      )
    }
    const drained = Promise.all([pipe(child.stdout, io.out), pipe(child.stderr, io.err)])
    const forward = (signal) => () => child.kill(signal)
    const handlers = { SIGINT: forward('SIGINT'), SIGTERM: forward('SIGTERM'), SIGHUP: forward('SIGHUP') }
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler)
    const finish = async (code) => {
      await drained
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler)
      resolve(code)
    }
    child.once('error', (error) => {
      io.err(`purser: could not run ${command}: ${error.code === 'ENOENT' ? 'command not found' : error.message}\n`)
      void finish(127)
    })
    child.once('exit', (code, signal) => void finish(code ?? (signal ? 128 + (process.constants?.signals?.[signal] ?? 1) : 1)))
  })
}

/** Runs one command line and resolves with its exit code. `io` is swapped out in tests. */
export async function main(argv, io) {
  const [verb, ...rest] = argv
  try {
    if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
      io.out(`${HELP}\n`)
      return 0
    }
    if (verb === 'list' || verb === 'ls') return await list(io)
    if (verb === 'need' || verb === 'ask') return await need(rest, io)
    if (verb === 'run') return await run(rest, io)
    io.err(`purser: unknown command "${verb}". Run purser help.\n`)
    return EXIT.usage
  } catch (error) {
    if (error instanceof Unreachable) {
      io.err(`${explainUnreachable(error)}\n`)
      return EXIT.unavailable
    }
    io.err(`purser: ${error.message}\n`)
    return 1
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    out: (text) => text && process.stdout.write(text),
    err: (text) => text && process.stderr.write(text)
  }).then((code) => {
    process.exitCode = code
  })
}
