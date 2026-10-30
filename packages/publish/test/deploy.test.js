/**
 * `awt site deploy`: the plan for a library's tree, the nginx config and pages it writes, and the rsync
 * calls that copy releases in. rsync is stood in for where the call is what is under test, and run for
 * real against a local tree where the result is.
 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test, {after} from 'node:test'

import {accessFor, deployAfterPublish, indexPage, nginxConf, planDeploy, runDeploy} from '../lib/deploy.js'
import {loadMachine} from '../lib/machine.js'

const made = []
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

function setup(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-deploy-'))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), {recursive: true})
    writeFileSync(join(dir, name), text)
  }
  return dir
}

const release = (slug, page = 'hello') => ({
  [`build/published/${slug}/static/contentIndex.json`]: '{}',
  [`build/published/${slug}/index.html`]: page,
  [`build/published/${slug}/static/awtRelease.json`]: '{"builtAt":"2026-10-30T00:00:00Z"}',
})

/** A local library over a tree in a scratch directory, and one deployed over ssh with access rules. */
function machine() {
  const tree = setup()
  const dios = setup({...release('localhost-8088-wikis'), ...release('wikis-example-org')})
  const photo = setup()
  const cfg = setup({
    'awt.yaml': 'default-library: local\n',
    'libraries/local.yaml': `base: http://localhost:8088/wikis
title: Wikis here
deploy:
  to: ${tree}
collections:
  tools:
    path: tools
    title: Tools
  shelton:
    path: clients/shelton
    title: Shelton
    wikis:
      shelton-dios:
        name: dios
        site: ${dios}
      photo-cli:
        site: ${photo}
`,
    'libraries/proton.yaml': `base: https://wikis.example.org
title: Lab "wikis"
access:
  allow:
    - 10.0.0.0/24
  basic: ol1-admin
trusted-proxies:
  - 10.0.0.100
deploy:
  to: proton:/opt/docker/awt-wikis/
collections:
  shelton:
    path: shelton
    title: Shelton
    access:
      basic: shelton
    wikis:
      shelton-dios:
        site: ${dios}
      remote-only:
        repo: git@github.com:x/r.git
        path: wiki
  open:
    path: open
    wikis:
      photo-cli:
        site: ${photo}
`,
  })
  return {m: loadMachine({dir: cfg}), tree, dios, photo}
}

test('the plan lists each wiki with its release, or says why it has none', () => {
  const {m, dios} = machine()
  const plan = planDeploy({machine: m, libraryName: 'local'})
  assert.equal(plan.to.path, plan.to.spec)
  assert.deepEqual(plan.wikis.map((w) => [w.key, w.path, w.state]), [['shelton-dios', 'clients/shelton/dios', 'ready'], ['photo-cli', 'clients/shelton/photo-cli', 'skipped']])
  assert.equal(plan.wikis[0].release, join(dios, 'build', 'published', 'localhost-8088-wikis'))
  assert.match(plan.wikis[1].reason, /no release for this library yet; run awt site publish --library local/)
  assert.deepEqual(Object.keys(plan.files).sort(), [join('conf.d', 'default.conf'), join('library', 'clients', 'shelton', 'index.html'), join('library', 'index.html'), join('library', 'tools', 'index.html')])

  const remote = planDeploy({machine: m, libraryName: 'proton'})
  assert.match(remote.wikis.find((w) => w.key === 'remote-only').reason, /no site on this machine; the pipeline builds it/)
  assert.deepEqual(planDeploy({machine: m, libraryName: 'local', only: 'photo-cli'}).wikis.map((w) => w.key), ['photo-cli'])
  assert.throws(() => planDeploy({machine: m, libraryName: 'nope'}), /no library "nope"; libraries are local, proton/)
})

test('the config serves the tree under the base, and redirects a directory to its slash', () => {
  const {m} = machine()
  const conf = nginxConf(m.targets.get('local'))
  assert.match(conf, /location \/wikis\/ \{\n {8}alias \/srv\/library\/;\n[^}]*try_files \$uri \$uri\.html \$uri\/index\.html =404;/)
  assert.match(conf, /location = \/wikis \{ alias \/srv\/library; \}/)
  assert.match(conf, /location = \/wikis\/clients\/shelton \{ alias \/srv\/library\/clients\/shelton; \}/, 'a collection')
  assert.match(conf, /location = \/wikis\/clients\/shelton\/dios \{ alias \/srv\/library\/clients\/shelton\/dios; \}/, 'and a wiki')
  assert.doesNotMatch(conf, /return 301/, 'nginx redirects a directory itself, after the access phase')
  assert.match(conf, /absolute_redirect off;/)
  assert.doesNotMatch(conf, /allow|auth_basic|real_ip/, 'a library with no access rules has none')
})

test('access is the library\'s, narrowed per collection, and the reader\'s address comes from the trusted proxy', () => {
  const {m} = machine()
  const proton = m.targets.get('proton')
  const conf = nginxConf(proton)
  assert.match(conf, /set_real_ip_from 10\.0\.0\.100;\n {4}real_ip_header X-Forwarded-For;\n {4}real_ip_recursive on;/)
  assert.match(conf, /location \/ \{\n {8}alias \/srv\/library\/;\n {8}allow 10\.0\.0\.0\/24;\n {8}deny all;\n {8}auth_basic "Lab 'wikis'";\n {8}auth_basic_user_file \/etc\/nginx\/htpasswd\/ol1-admin;/)
  assert.match(conf, /location \/shelton\/ \{\n {8}alias \/srv\/library\/shelton\/;\n {8}allow 10\.0\.0\.0\/24;\n {8}deny all;\n[^}]*htpasswd\/shelton;/, 'a collection keeps the library\'s allow and replaces its login')
  assert.doesNotMatch(conf, /location \/open\//, 'a collection with no rules of its own needs no location')
  assert.match(conf, /location = \/shelton\/shelton-dios \{\n {8}alias \/srv\/library\/shelton\/shelton-dios;\n {8}allow 10\.0\.0\.0\/24;\n {8}deny all;\n[^}]*htpasswd\/shelton;\n {4}\}/, 'a slashless address is behind its collection\'s rules, so it says nothing about which wikis exist')
  assert.match(conf, /location = \/open \{\n {8}alias \/srv\/library\/open;\n[^}]*htpasswd\/ol1-admin;/, 'and behind the library\'s where the collection has none of its own')
  assert.doesNotMatch(conf, /location = {2}\{/, 'no redirect for a base with no path')
  assert.deepEqual(accessFor(proton, proton.collections[0]), {allow: ['10.0.0.0/24'], basic: 'shelton'})
})

test('the pages link relatively and cannot be broken out of by what a wiki is called', () => {
  const {m} = machine()
  const library = m.targets.get('local')
  const landing = indexPage({library, collections: library.collections, depth: 0})
  assert.match(landing, /"href":"clients\/shelton\/dios\/"/)
  assert.match(landing, /<title>Wikis here<\/title>/)
  const collection = indexPage({library, collections: [library.collections[1]], depth: 2})
  assert.match(collection, /"href":"\.\.\/\.\.\/clients\/shelton\/dios\/"/, 'from clients/shelton/, two levels up and back down')
  assert.match(collection, /<title>Shelton · Wikis here<\/title>/)
  library.collections[1].title = '</script><b>'
  assert.ok(!indexPage({library, collections: library.collections, depth: 0}).includes('</script><b>'), 'a title with markup in it stays data')
})

test('a local deploy writes the pages, copies each release with rsync, and a dry run touches nothing', () => {
  const {m, tree} = machine()
  const plan = planDeploy({machine: m, libraryName: 'local'})
  runDeploy(plan, {dryRun: true})
  assert.ok(!existsSync(join(tree, 'library')), 'a dry run wrote nothing')

  const steps = runDeploy(plan)
  assert.deepEqual(steps.map((s) => s.step), ['pages', 'release'])
  assert.equal(readFileSync(join(tree, 'library', 'clients', 'shelton', 'dios', 'index.html'), 'utf8'), 'hello')
  assert.ok(existsSync(join(tree, 'library', 'index.html')) && existsSync(join(tree, 'conf.d', 'default.conf')))
  assert.ok(!existsSync(join(tree, 'library', 'clients', 'shelton', 'photo-cli')), 'a wiki with no release is not there')
})

test('a release copied again loses the files it no longer has', () => {
  const {m, tree, dios} = machine()
  writeFileSync(join(dios, 'build', 'published', 'localhost-8088-wikis', 'gone.html'), 'x')
  runDeploy(planDeploy({machine: m, libraryName: 'local'}))
  assert.ok(existsSync(join(tree, 'library', 'clients', 'shelton', 'dios', 'gone.html')))
  rmSync(join(dios, 'build', 'published', 'localhost-8088-wikis', 'gone.html'))
  runDeploy(planDeploy({machine: m, libraryName: 'local'}), {pages: false})
  assert.ok(!existsSync(join(tree, 'library', 'clients', 'shelton', 'dios', 'gone.html')))
})

test('a remote deploy stages the pages and sends everything over ssh with --delay-updates', () => {
  const {m, dios} = machine()
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    return {status: 0, stdout: '', stderr: ''}
  }
  runDeploy(planDeploy({machine: m, libraryName: 'proton'}), {run})
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].slice(0, 2), ['rsync', '-a'])
  assert.equal(calls[0].at(-1), 'proton:/opt/docker/awt-wikis/', 'the pages and the config, staged and sent together')
  assert.deepEqual(calls[1], ['rsync', '-a', '--delete', '--delay-updates', `${join(dios, 'build', 'published', 'wikis-example-org')}/`, 'proton:/opt/docker/awt-wikis/library/shelton/shelton-dios/'])

  const failing = () => ({status: 23, stdout: '', stderr: 'rsync: connection refused\n'})
  assert.throws(() => runDeploy(planDeploy({machine: m, libraryName: 'proton'}), {run: failing}), /rsync .* failed: rsync: connection refused/)
})

test('after a publish the release goes into a local library\'s tree, and nowhere for one over ssh', () => {
  const {m, tree} = machine()
  const local = m.targets.get('local')
  const done = deployAfterPublish({machine: m, target: {targetName: 'local'}, key: 'shelton-dios'})
  assert.equal(done.library, 'local')
  assert.ok(existsSync(join(tree, 'library', 'clients', 'shelton', 'dios', 'index.html')))
  assert.ok(existsSync(join(tree, 'library', 'index.html')), 'the first copy writes the pages too')
  void local

  const calls = []
  const run = (...args) => (calls.push(args), {status: 0})
  assert.equal(deployAfterPublish({machine: m, target: {targetName: 'proton'}, key: 'shelton-dios', run}), null, 'a save is not a reason to reach another machine')
  assert.equal(deployAfterPublish({machine: m, target: {targetName: 'local'}, key: 'not-a-member', run}), null)
  assert.equal(deployAfterPublish({machine: m, target: {base: 'https://x.org'}, key: 'shelton-dios', run}), null, 'a bare base belongs to no library')
  assert.equal(calls.length, 0)
})

test('rsync is the one on this machine, and takes the flags deploy passes', () => {
  const probe = spawnSync('rsync', ['--version'], {encoding: 'utf8'})
  assert.equal(probe.status, 0, 'rsync is installed')
  const src = setup({'a.txt': 'a'})
  const dst = join(setup(), 'out')
  mkdirSync(dst)
  const done = spawnSync('rsync', ['-a', '--delete', '--delay-updates', `${src}/`, `${dst}/`], {encoding: 'utf8'})
  assert.equal(done.status, 0, done.stderr)
  assert.equal(readFileSync(join(dst, 'a.txt'), 'utf8'), 'a')
})
