/**
 * The Stop hook that keeps a published wiki current, run as Claude Code runs it: a script, the
 * project directory in the environment, the hook input on stdin, an exit code and nothing else.
 *
 * What matters about it is what it does not do. It must return at once and successfully wherever
 * there is no wiki to publish, and it must not make a first release. The decision about staleness
 * belongs to `awt site publish --if-stale`, which stale.test.js covers.
 *
 * Which wikis it publishes is the other half: the ones the session touched, as wiki-docs-touch.sh
 * recorded them, so a session rooted above several projects publishes the wikis it wrote into.
 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test, {after} from 'node:test'

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks')
const HOOK = join(HOOKS, 'wiki-docs-publish.sh')
const TOUCH = join(HOOKS, 'wiki-docs-touch.sh')

const made = []
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-hook-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

/** The hook's log is named for the project directory, so the test finds it the way the hook makes it. */
function logFor(scratch, project) {
  const sum = spawnSync('sh', ['-c', `printf '%s' "$1" | cksum | cut -d' ' -f1`, 'sh', project], {encoding: 'utf8'}).stdout.trim()
  return join(scratch, `awt-publish-${sum}.log`)
}

function run(project, scratch, input = {}, hook = HOOK) {
  const env = {...process.env, TMPDIR: scratch, AWT_CONFIG_DIR: join(scratch, 'config'), AWT_TARGET: ''}
  delete env.CLAUDE_PROJECT_DIR
  if (project !== undefined) env.CLAUDE_PROJECT_DIR = project
  const started = Date.now()
  const r = spawnSync('bash', [hook], {encoding: 'utf8', env, input: JSON.stringify(input)})
  return {status: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - started}
}

/** A wiki with one note and no release, which is all `--if-stale` needs to say "no release yet". */
function wiki(dir = tmp()) {
  mkdirSync(dir, {recursive: true})
  writeFileSync(join(dir, 'awt.config.mjs'), "export default {site: {title: 'T', self: 't'}}\n")
  mkdirSync(join(dir, 'wiki/notes'), {recursive: true})
  mkdirSync(join(dir, 'wiki/site'), {recursive: true})
  writeFileSync(join(dir, 'wiki/notes/a.md'), '---\ntitle: A\ntype: note\n---\n\n# A\n')
  return dir
}

/** What wiki-docs-touch.sh leaves for a session: one wiki root per line. */
function touched(scratch, session, roots) {
  writeFileSync(join(scratch, `wiki-docs-${session}.touched`), roots.map((r) => `${r}\n`).join(''))
}

async function waitFor(file, ms = 10000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(file) && readFileSync(file, 'utf8').length) return readFileSync(file, 'utf8')
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

test('with no project directory the hook does nothing', () => {
  const r = run(undefined, tmp())
  assert.equal(r.status, 0)
  assert.equal(r.out, '')
})

test('a project with no awt.config.mjs is not a wiki, and no process is started for it', () => {
  const scratch = tmp()
  const project = tmp()
  const r = run(project, scratch)
  assert.equal(r.status, 0)
  assert.equal(r.out, '')
  assert.ok(!existsSync(logFor(scratch, project)), 'no build was started, so there is no log')
})

test('a wiki that was never published is left alone, and the hook returns at once', async () => {
  const scratch = tmp()
  const project = wiki()
  const r = run(project, scratch)
  assert.equal(r.status, 0)
  assert.equal(r.out, '', 'the hook itself prints nothing; the build writes to its log')
  assert.ok(r.ms < 2000, `returned in ${r.ms} ms`)
  const log = await waitFor(logFor(scratch, project))
  assert.ok(log, 'the background run wrote its log')
  assert.match(log, /no release yet/)
  assert.ok(!existsSync(join(project, 'wiki/site/build')), 'nothing was built, not even the index')
})

test('the wikis a session touched are published, though the project directory is none of them', async () => {
  const scratch = tmp()
  const workspace = tmp()
  const one = wiki(join(workspace, 'one'))
  const two = wiki(join(workspace, 'two'))
  touched(scratch, 's1', [one, two, one])
  const r = run(workspace, scratch, {session_id: 's1'})
  assert.equal(r.status, 0)
  assert.equal(r.out, '')
  for (const root of [one, two]) {
    const log = await waitFor(logFor(scratch, root))
    assert.ok(log, `a run was started for ${root}`)
    assert.match(log, /no release yet/)
  }
  assert.ok(!existsSync(logFor(scratch, workspace)), 'the project directory is not a wiki, and nothing ran for it')
})

test('a session that touched no wiki, in a project that is none, starts nothing', () => {
  const scratch = tmp()
  const project = tmp()
  const r = run(project, scratch, {session_id: 's2'})
  assert.equal(r.status, 0)
  assert.equal(r.out, '')
  assert.ok(!existsSync(logFor(scratch, project)))
})

test('a note written from outside its wiki is recorded against that wiki, and published at stop', async () => {
  const scratch = tmp()
  const workspace = tmp()
  const root = wiki(join(workspace, 'repo'))
  const note = join(root, 'wiki/notes/a.md')
  const write = {session_id: 's3', tool_name: 'Write', cwd: workspace, tool_input: {file_path: note}}
  assert.equal(run(workspace, scratch, write, TOUCH).status, 0)
  assert.equal(readFileSync(join(scratch, 'wiki-docs-s3.touched'), 'utf8'), `${root}\n`)
  assert.equal(readFileSync(join(scratch, 'wiki-docs-s3.files'), 'utf8'), `${note}\n`)

  // A second write to the same wiki does not repeat it in the record.
  assert.equal(run(workspace, scratch, write, TOUCH).status, 0)
  assert.equal(readFileSync(join(scratch, 'wiki-docs-s3.touched'), 'utf8'), `${root}\n`)

  assert.equal(run(workspace, scratch, {session_id: 's3'}).status, 0)
  const log = await waitFor(logFor(scratch, root))
  assert.ok(log, 'the touched wiki was published')
  assert.match(log, /no release yet/)
})
