/**
 * `awt site host`: the container that serves a library's tree, and what it is asked once it runs.
 *
 * The plan is data, so it is asserted as data. `docker` and the HTTP probe are stood in for, since what
 * matters here is which commands are run and what is made of the answers; the real thing was run
 * against real Docker and nginx when this was written.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test, {after} from 'node:test'

import {planDeploy} from '../lib/deploy.js'
import {containerName, down, LABEL, planHost, probe, up} from '../lib/host.js'
import {loadMachine} from '../lib/machine.js'

const made = []
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

function setup(files) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-host-'))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), {recursive: true})
    writeFileSync(join(dir, name), text)
  }
  return dir
}

/** A machine with a local library of two wikis, one with a release for it, and a library elsewhere. */
function machine() {
  const a = setup({'build/published/localhost-8088-wikis/static/contentIndex.json': '{}', 'build/published/localhost-8088-wikis/index.html': 'x'})
  const b = setup({})
  const collections = `collections:\n  shelton:\n    path: shelton\n    wikis:\n      dios:\n        site: ${a}\n      photo-cli:\n        site: ${b}\n`
  const cfg = setup({
    'libraries/local.yaml': `base: http://localhost:8088/wikis\ndeploy:\n  to: /h/tree\n${collections}`,
    'libraries/root.yaml': `base: http://localhost:9000\ndeploy:\n  to: /h/root\n${collections}`,
    'libraries/public.yaml': `base: https://example.org/docs\ndeploy:\n  to: example:/srv/wikis\n${collections}`,
    'libraries/nodeploy.yaml': `base: http://localhost:7000\n${collections}`,
  })
  const m = loadMachine({dir: cfg})
  const plan = (name, port) => planHost({machine: m, targetName: name, deploy: planDeploy({machine: m, libraryName: name}), port})
  return {m, plan, a, b}
}

test('the tree and the config are mounted at the paths the server contract names', () => {
  const {plan} = machine()
  const local = plan('local')
  assert.equal(local.port, 8088)
  assert.equal(local.local, true)
  assert.equal(local.dir, '/h/tree')
  const volumes = local.docker.args.filter((_, i, all) => all[i - 1] === '-v')
  assert.deepEqual(volumes, ['/h/tree/conf.d:/etc/nginx/conf.d:ro', '/h/tree/library:/srv/library:ro'], 'two directories and nothing of any checkout')
  assert.deepEqual(local.wikis.map((w) => [w.key, w.state, w.path]), [['dios', 'ready', '/wikis/shelton/dios/'], ['photo-cli', 'skipped', '/wikis/shelton/photo-cli/']])
})

test('the container is bound to this machine only, named and labelled for its library', () => {
  const {plan} = machine()
  const args = plan('local', 9100).docker.args
  assert.equal(plan('local').docker.name, containerName('local'))
  assert.deepEqual(args.slice(0, 4), ['run', '-d', '--name', 'awt-host-local'])
  assert.ok(args.includes('127.0.0.1:9100:80'), 'published on loopback, on the port asked for')
  assert.equal(args[args.indexOf('--label') + 1], `${LABEL}=local`)
  assert.equal(args.at(-1), 'nginx:alpine')
})

test('a base with no path is served at the root, and a library with no tree here cannot be hosted', () => {
  const {m, plan} = machine()
  const root = plan('root')
  assert.equal(root.port, 9000)
  assert.equal(root.wikis[0].path, '/shelton/dios/')
  assert.throws(() => plan('public'), /"public" does not deploy to a directory on this machine/)
  assert.throws(() => planHost({machine: m, targetName: 'nope', deploy: {wikis: []}}), /no library "nope"; libraries are local, nodeploy, public, root/)
  assert.throws(() => planDeploy({machine: m, libraryName: 'nodeploy'}), /has no deploy\.to/)
})

/** A stand-in `docker` that records what it was asked and answers from a table. */
function fakeDocker({exists = null, running = 'true', label = 'local', fail = null} = {}) {
  const calls = []
  const run = (cmd, args) => {
    assert.equal(cmd, 'docker')
    calls.push(args)
    if (args[0] === 'version') return {status: fail === 'version' ? 1 : 0, stdout: '29.5.2\n', stderr: ''}
    if (args[0] === 'inspect') return exists ? {status: 0, stdout: `${running} ${label}\n`, stderr: ''} : {status: 1, stdout: '', stderr: 'no such object'}
    if (args[0] === 'rm') return {status: 0, stdout: '', stderr: ''}
    if (args[0] === 'run') return fail === 'run' ? {status: 125, stdout: '', stderr: 'port is already allocated\n'} : {status: 0, stdout: 'abc123def4567890\n', stderr: ''}
    throw new Error(`unexpected docker ${args.join(' ')}`)
  }
  return {run, calls}
}

test('up starts a container, replaces one that is ours, and refuses one that is not', () => {
  const plan = machine().plan('local')

  const fresh = fakeDocker()
  assert.deepEqual(up(plan, {run: fresh.run}), {name: 'awt-host-local', id: 'abc123def456'})
  assert.deepEqual(fresh.calls.map((c) => c[0]), ['version', 'inspect', 'run'])

  const replaced = fakeDocker({exists: true})
  up(plan, {run: replaced.run})
  assert.deepEqual(replaced.calls.map((c) => c[0]), ['version', 'inspect', 'rm', 'run'], 'ours is removed before the new one starts')

  const stranger = fakeDocker({exists: true, label: '<no value>'})
  assert.throws(() => up(plan, {run: stranger.run}), /named awt-host-local exists and was not started by awt site host/)
  assert.ok(!stranger.calls.some((c) => c[0] === 'rm' || c[0] === 'run'), 'a container that is not ours is never removed')

  assert.throws(() => up(plan, {run: fakeDocker({fail: 'version'}).run}), /docker is not running/)
  assert.throws(() => up(plan, {run: fakeDocker({fail: 'run'}).run}), /docker run failed: port is already allocated/)
})

test('down removes our container, finds nothing to remove without complaint, and leaves a stranger', () => {
  assert.deepEqual(down('local', {run: fakeDocker({exists: true}).run}), {name: 'awt-host-local', removed: true})
  assert.deepEqual(down('local', {run: fakeDocker().run}), {name: 'awt-host-local', removed: false})
  assert.throws(() => down('local', {run: fakeDocker({exists: true, label: 'other'}).run}), /was not started by awt site host/)
})

test('the probe asks the server, waits for it to start, and explains a release it cannot see', async () => {
  const plan = machine().plan('local')
  const answers = {
    'http://127.0.0.1:8088/wikis/': [0, 0, 200],
    'http://127.0.0.1:8088/wikis/shelton/dios/': [404],
    'http://127.0.0.1:8088/wikis/shelton/photo-cli/': [404],
  }
  const get = async (url) => (answers[url].length > 1 ? answers[url].shift() : answers[url][0])
  let clock = 0
  const result = await probe(plan, {get, wait: 5000, now: () => clock, sleep: async (ms) => void (clock += ms)})

  assert.equal(result.landing, 200, 'it waited out two refused connections')
  const dios = result.wikis.find((w) => w.key === 'dios')
  assert.equal(dios.serving, false)
  assert.match(dios.note, /its release was copied into the tree and the container does not see it; Docker may not share \/h\/tree/)
  assert.equal(result.wikis.find((w) => w.key === 'photo-cli').note, 'not deployed yet')
})
