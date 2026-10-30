/**
 * The address a release is built for: where it comes from, what it becomes, and how a
 * release's own record is compared with it.
 *
 * `die` exits the process in the real code. Here it throws, which is the behaviour under
 * test: reaching it at all is the assertion.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test, {after} from 'node:test'

import {planRelease, verifyRelease, RELEASE_RECORD} from '../lib/release.js'
import {compareRecord, releaseRecord, resolveTarget, retargetScheme} from '../lib/target.js'

const die = (message) => {
  throw new Error(message)
}

const made = []
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

// `planRelease` and `verifyRelease` read the machine's own configuration unless told where it is. A machine
// that has a real one, with a default target, would change every answer here, so these tests have none.
const realConfig = process.env.AWT_CONFIG_DIR
process.env.AWT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'awt-target-noconfig-'))
made.push(process.env.AWT_CONFIG_DIR)
after(() => {
  if (realConfig === undefined) delete process.env.AWT_CONFIG_DIR
  else process.env.AWT_CONFIG_DIR = realConfig
})

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-target-'))
  made.push(dir)
  return dir
}

test('a base, a mount and a name make the address, with the base free to carry a path', () => {
  const t = resolveTarget({base: 'https://example.org/docs/', mount: 'shelton', name: 'photo-cli'}, {}, die)
  assert.equal(t.url, 'https://example.org/docs/shelton/photo-cli')
  assert.equal(t.base, 'https://example.org/docs')
  assert.equal(t.hostPath, 'example.org/docs/shelton/photo-cli', 'what Quartz takes, with no scheme')
  assert.equal(t.slug, 'example-org-docs')
  assert.deepEqual([t.mount, t.name], ['shelton', 'photo-cli'])
})

test('flags win over the declaration, and the name falls back to site.self', () => {
  const declaration = {baseUrl: 'wiki.example.org', mount: 'aisandbox', self: 'aisandbox'}
  assert.equal(resolveTarget({}, declaration, die).url, 'https://wiki.example.org/aisandbox/aisandbox')
  const flagged = resolveTarget({base: 'http://localhost:8088/wikis', mount: 'shelton', name: 'dios'}, declaration, die)
  assert.equal(flagged.url, 'http://localhost:8088/wikis/shelton/dios')
})

test('a base with no mount is the target it always was: the release is served at the base itself', () => {
  const t = resolveTarget({}, {baseUrl: 'wiki.example.org', self: 'dios'}, die)
  assert.equal(t.url, 'https://wiki.example.org')
  assert.equal(t.hostPath, 'wiki.example.org')
  assert.equal(t.mount, null)
})

test('a base written with no scheme is https, and one written with http keeps it', () => {
  assert.equal(resolveTarget({base: 'localhost:8088/wikis'}, {}, die).scheme, 'https')
  assert.equal(resolveTarget({base: 'http://localhost:8088/wikis'}, {}, die).scheme, 'http')
})

test('no base anywhere is no target, and a mount or name with nothing to sit under is refused', () => {
  assert.equal(resolveTarget({}, {self: 'dios'}, die), null)
  assert.throws(() => resolveTarget({mount: 'shelton'}, {}, die), /no base/)
  assert.throws(() => resolveTarget({name: 'dios'}, {}, die), /no base/)
})

test('a mount needs a name, and a name needs a mount', () => {
  assert.throws(() => resolveTarget({base: 'example.org', mount: 'shelton'}, {}, die), /needs the wiki's name/)
  assert.throws(() => resolveTarget({base: 'example.org', name: 'dios'}, {}, die), /no mount/)
})

test('what is not a path segment, a host or a plain base is refused by name', () => {
  assert.throws(() => resolveTarget({base: 'example.org', mount: 'Shel/ton', name: 'x'}, {}, die), /mount "Shel\/ton" is not a path/)
  assert.throws(() => resolveTarget({base: 'example.org', mount: 'clients//x', name: 'x'}, {}, die), /mount "clients\/\/x" is not a path/)
  assert.equal(resolveTarget({base: 'example.org', mount: 'clients/shelton', name: 'dios'}, {}, die).url, 'https://example.org/clients/shelton/dios')
  assert.throws(() => resolveTarget({base: 'example.org', mount: 'a', name: '../x'}, {}, die), /name "..\/x" is not a path segment/)
  assert.throws(() => resolveTarget({base: 'ftp://example.org'}, {}, die), /scheme other than http or https/)
  assert.throws(() => resolveTarget({base: 'https://example.org/docs?x=1'}, {}, die), /query, fragment or credentials/)
  assert.throws(() => resolveTarget({base: 'https://u:p@example.org'}, {}, die), /query, fragment or credentials/)
})

test('the scheme is rewritten only on the target\'s own address, and only for http', () => {
  const t = resolveTarget({base: 'http://localhost:8088/wikis', mount: 'shelton', name: 'dios'}, {}, die)
  const page =
    '<loc>https://localhost:8088/wikis/shelton/dios/readme</loc>' +
    '<meta content="https://localhost:8088/wikis/shelton/dios"/>' +
    '<a href="https://localhost:8088/wikis/shelton/dios-data/x">other wiki</a>' +
    '<a href="https://fonts.googleapis.com">font</a>'
  const out = retargetScheme(page, t)
  assert.match(out, /<loc>http:\/\/localhost:8088\/wikis\/shelton\/dios\/readme</)
  assert.match(out, /content="http:\/\/localhost:8088\/wikis\/shelton\/dios"/)
  assert.match(out, /https:\/\/localhost:8088\/wikis\/shelton\/dios-data\/x/, 'a sibling that shares the prefix is left alone')
  assert.match(out, /https:\/\/fonts\.googleapis\.com/)

  const secure = resolveTarget({base: 'https://example.org', mount: 'a', name: 'b'}, {}, die)
  assert.equal(retargetScheme(page, secure), page)
})

test('a release records the address it was built for, and is compared with the one it should have', () => {
  const t = resolveTarget({base: 'http://localhost:8088/wikis', mount: 'shelton', name: 'dios'}, {}, die)
  const record = releaseRecord(t, {builtAt: new Date('2026-10-04T12:00:00Z')})
  assert.deepEqual(record, {
    version: 1,
    mode: 'release',
    url: 'http://localhost:8088/wikis/shelton/dios',
    base: 'http://localhost:8088/wikis',
    mount: 'shelton',
    name: 'dios',
    builtAt: '2026-10-04T12:00:00.000Z',
  })

  assert.equal(compareRecord(record, t).reason, 'match')
  const elsewhere = resolveTarget({base: 'https://example.org/docs', mount: 'shelton', name: 'dios'}, {}, die)
  assert.deepEqual(compareRecord(record, elsewhere), {
    ok: false,
    reason: 'mismatch',
    recorded: 'http://localhost:8088/wikis/shelton/dios',
    expected: 'https://example.org/docs/shelton/dios',
  })
  assert.equal(compareRecord(null, t).reason, 'no-record', 'a release with no record is its own answer')
  assert.equal(compareRecord(record, null).reason, 'no-target')
  assert.equal(releaseRecord(null).url, null, 'a build with no declared address still says so')
})

test('every target lands in build/published/<base>, a build with no target in default, and a handoff copy in build/handoff', () => {
  const site = '/p/site'
  const declared = {baseUrl: 'wiki.example.org', mount: 'aisandbox', self: 'aisandbox'}
  assert.equal(planRelease({}, site, declared).out, join(site, 'build', 'published', 'wiki-example-org'), 'a declared base is one target like any other')
  assert.equal(planRelease({}, site, {}).out, join(site, 'build', 'published', 'default'), 'no target at all is `default`')

  const flagged = planRelease({base: 'http://localhost:8088/wikis'}, site, declared)
  assert.equal(flagged.out, join(site, 'build', 'published', 'localhost-8088-wikis'))
  assert.equal(flagged.target.url, 'http://localhost:8088/wikis/aisandbox/aisandbox')

  assert.equal(planRelease({out: '/elsewhere'}, site, declared).out, '/elsewhere', '--out is never second-guessed')
  assert.equal(planRelease({offline: true}, site, declared).out, join(site, 'build', 'handoff'))
})

test('verify answers 0 for a release built for the target, 1 for any other, and says why', () => {
  const site = tmp()
  const out = join(site, 'build', 'published', 'localhost-8088-wikis')
  const record = releaseRecord(resolveTarget({base: 'http://localhost:8088/wikis', mount: 'shelton', name: 'dios'}, {}, die))
  mkdirSync(dirname(join(out, RELEASE_RECORD)), {recursive: true})
  writeFileSync(join(out, RELEASE_RECORD), JSON.stringify(record))

  const quiet = (run) => {
    const write = process.stdout.write
    process.stdout.write = () => true
    try {
      return run()
    } finally {
      process.stdout.write = write
    }
  }
  // The directory is named, so one published site is compared with different targets: each target has a
  // directory of its own, and verifying a base nothing was published for is "no release there", not a mismatch.
  const asked = (declaration) => ['--site', site, '--out', out, '--site-config', JSON.stringify(declaration), '--json']

  assert.equal(quiet(() => verifyRelease(asked({baseUrl: 'http://localhost:8088/wikis', mount: 'shelton', self: 'dios'}))), 0)
  assert.equal(quiet(() => verifyRelease(asked({baseUrl: 'https://example.org', mount: 'shelton', self: 'dios'}))), 1)
  assert.equal(quiet(() => verifyRelease(asked({}))), 0, 'a project that names no target has nothing to disagree with')
})
