// The output filter of `purser run`: values must not get through, even split across chunks.
import { assert, test } from 'orca/testing'
// @ts-expect-error plain JavaScript, no declaration file
import { createRedactor, parseRun, substitute } from '../cli/purser.mjs'

const VALUE = 'ghp_0123456789abcdefABCDEF'

function through(chunks: string[], values: Record<string, string>): string {
  const redactor = createRedactor(values)
  return chunks.map((chunk) => redactor.push(chunk)).join('') + redactor.flush()
}

test('hides a value split across any two chunks', () => {
  const text = `token=${VALUE}; done`
  for (let cut = 1; cut < text.length; cut += 1) {
    const out = through([text.slice(0, cut), text.slice(cut)], { GH_TOKEN: VALUE })
    assert.equal(out, 'token=[purser:GH_TOKEN]; done', `cut at ${cut}`)
  }
})

test('hides common encodings of a value', () => {
  const b64 = Buffer.from(VALUE).toString('base64')
  const hex = Buffer.from(VALUE).toString('hex')
  const out = through([`${b64} ${hex} ${encodeURIComponent(VALUE)}`], { GH_TOKEN: VALUE })
  assert.ok(!out.includes(b64) && !out.includes(hex), out)
})

test('leaves short values alone rather than mangling ordinary text', () => {
  assert.equal(through(['port 1234 is open'], { PIN: '1234' }), 'port 1234 is open')
})

test('fills {{NAME}} inside an argument and reports names it does not have', () => {
  const { args, missing } = substitute(['-H', 'Bearer {{ TOKEN }}', '{{NOPE}}'], { TOKEN: 'x' })
  assert.deepEqual(args, ['-H', 'Bearer x', '{{NOPE}}'])
  assert.deepEqual(missing, ['NOPE'])
})

test('parses run options', () => {
  assert.deepEqual(parseRun(['--only', 'A,B', '--', 'npm', 'publish']), { only: ['A', 'B'], command: ['npm', 'publish'] })
  assert.deepEqual(parseRun(['curl', '-s']), { only: undefined, command: ['curl', '-s'] })
  assert.ok(parseRun(['--']).error)
})
