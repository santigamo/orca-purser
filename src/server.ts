// The local socket the `purser` command talks to. One JSON line in, one JSON line out.
// Access control is the file system's: the socket sits in a folder only this user can open.
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { connect, createServer, type Server } from 'node:net'
import { dirname } from 'node:path'

export type Request = { op: string; [key: string]: unknown }
/** `signal` aborts when the command line hangs up, so a long wait can stop. */
export type Handle = (request: Request, context: { signal: AbortSignal }) => Promise<Record<string, unknown>>

const MAX_REQUEST_BYTES = 64 * 1024

/** Whether something answers on `path`: a running Purser, as opposed to a file a crash left. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

/**
 * Listens on `path`, or returns null when another Purser already does (a second Orca, or
 * `orca plugin check` running this worker beside the real one): that one keeps serving.
 */
export async function serve(path: string, handle: Handle, log: (message: string) => void): Promise<Server | null> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  // A worker restart closes the old socket a moment after the new worker starts: give it time.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await answers(path))) break
    if (attempt === 3) return null
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await unlink(path).catch(() => undefined)

  const server = createServer((socket) => {
    const hungUp = new AbortController()
    let buffer = ''
    let answered = false
    const reply = (body: Record<string, unknown>): void => {
      if (socket.destroyed) return
      socket.end(`${JSON.stringify(body)}\n`)
    }
    socket.setEncoding('utf8')
    socket.on('close', () => hungUp.abort())
    socket.on('error', () => hungUp.abort())
    socket.on('data', (chunk: string) => {
      if (answered) return
      buffer += chunk
      if (buffer.length > MAX_REQUEST_BYTES) {
        answered = true
        reply({ ok: false, error: 'request too large' })
        return
      }
      const end = buffer.indexOf('\n')
      if (end === -1) return
      answered = true
      let request: Request
      try {
        request = JSON.parse(buffer.slice(0, end)) as Request
        if (!request || typeof request.op !== 'string') throw new Error('no op')
      } catch {
        reply({ ok: false, error: 'bad request' })
        return
      }
      handle(request, { signal: hungUp.signal }).then(
        (body) => reply({ ok: true, ...body }),
        (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
      )
    })
  })
  server.on('error', (error) => log(`socket error: ${error.message}`))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(path, 0o600)
  return server
}

export async function stop(server: Server | null, path: string): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await unlink(path).catch(() => undefined)
}
