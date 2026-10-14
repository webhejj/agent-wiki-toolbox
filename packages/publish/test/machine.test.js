/**
 * The machine layer: what `~/.config/awt/` says, how it is checked, and what it becomes.
 *
 * Every test writes a configuration directory of its own and passes it in, so nothing reads or
 * writes the real one. `die` throws, which is the behaviour under test where a file is refused.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test, {after} from 'node:test'

import {
  addressOf,
  configDir,
  describeMachine,
  expandHome,
  homeFor,
  loadMachine,
  loadMachineIfPresent,
  pluginRegistry,
  readDefaultTarget,
  registerWiki,
  releaseFor,
  tildeHome,
  unregisterWiki,
} from '../lib/machine.js'
import {planRelease} from '../lib/release.js'

const made = []
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

/**
 * What `die` printed, for a call that is expected to refuse. `die` exits the process, which is what
 * it should do, so the exit is made a throw for the length of the call and the message is captured.
 */
function refusal(fn) {
  const exit = process.exit
  const error = console.error
  const printed = []
  process.exit = (code) => {
    throw Object.assign(new Error('exit'), {code})
  }
  console.error = (...args) => printed.push(args.join(' '))
  try {
    fn()
  } catch (e) {
    if (e.message !== 'exit') throw e
    return printed.join('\n')
  } finally {
    process.exit = exit
    console.error = error
  }
  assert.fail('expected a refusal, and the call went through')
}

/** A configuration directory with these files, relative to it. */
function config(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-machine-'))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name)
    mkdirSync(dirname(file), {recursive: true})
    writeFileSync(file, text)
  }
  return dir
}

const TARGETS = 'local:\n  base: http://localhost:8088/wikis\npublic:\n  base: https://example.org/docs\n'
const SHELTON = `# Shelton wikis
dios:
  mount: shelton
  name: dios
  site: /home/me/shelton-dios/wiki/site
photo-cli:
  mount: shelton
  name: photo-cli
  site: /home/me/photo-cli/wiki/site
`

test('the directory is $AWT_CONFIG_DIR, else awt under the platform\'s config directory', () => {
  assert.equal(configDir({AWT_CONFIG_DIR: '/x/y'}, 'linux'), '/x/y')
  assert.equal(configDir({XDG_CONFIG_HOME: '/xdg'}, 'linux'), '/xdg/awt')
  assert.equal(configDir({APPDATA: 'C:\\Users\\me\\AppData\\Roaming'}, 'win32').endsWith('awt'), true)
  assert.equal(expandHome('~/a/b', '/h'), '/h/a/b')
  assert.equal(tildeHome('/h/a/b', '/h'), '~/a/b')
  assert.equal(tildeHome('/elsewhere/a', '/h'), '/elsewhere/a')
})

test('targets, the default, and the registry load, with the file each came from', () => {
  const dir = config({'targets.yaml': TARGETS, 'default-target': 'local\n', 'registry.d/shelton.yaml': SHELTON})
  const machine = loadMachine({dir})
  assert.deepEqual([...machine.targets.keys()], ['local', 'public'])
  assert.equal(machine.targets.get('local').base, 'http://localhost:8088/wikis')
  assert.equal(machine.targets.get('local').slug, 'localhost-8088-wikis')
  assert.equal(machine.defaultTarget, 'local')
  assert.deepEqual([...machine.wikis.keys()], ['dios', 'photo-cli'])
  const dios = machine.wikis.get('dios')
  assert.deepEqual([dios.mount, dios.name, dios.site], ['shelton', 'dios', '/home/me/shelton-dios/wiki/site'])
  assert.equal(dios.from.mount, join(dir, 'registry.d', 'shelton.yaml'))
})

test('a machine with no configuration is not an error, and says nothing', () => {
  const dir = join(tmpdir(), 'awt-machine-absent-' + process.pid)
  assert.equal(loadMachineIfPresent({dir}), null)
  assert.equal(readDefaultTarget(dir), null)
  const empty = loadMachine({dir: config()})
  assert.equal(empty.targets.size + empty.wikis.size, 0)
})

test('a collision is an error naming both places, never a quiet override', () => {
  const twice = config({
    'registry.d/a.yaml': 'dios:\n  mount: a\n  name: dios\n',
    'registry.d/b.yaml': 'dios:\n  mount: b\n  name: dios\n',
  })
  assert.throws(() => loadMachine({dir: twice}), /"dios" is registered twice: .*a\.yaml and .*b\.yaml/)

  const sameAddress = config({'registry.d/a.yaml': 'one:\n  mount: m\n  name: n\ntwo:\n  mount: m\n  name: n\n'})
  assert.throws(() => loadMachine({dir: sameAddress}), /"one" and "two" are both m\/n/)

  const inFile = config({'registry.d/a.yaml': 'dios:\n  mount: a\ndios:\n  mount: b\n'})
  assert.throws(() => loadMachine({dir: inFile}), /a\.yaml:3: a key appears twice/)
})

test('what is wrong with a file is said with the file, the key and the field', () => {
  const bad = (files, pattern) => assert.throws(() => loadMachine({dir: config(files)}), pattern)
  bad({'registry.d/a.yaml': 'dios:\n  mout: x\n'}, /a\.yaml: dios has a field "mout"; the fields are mount, name, site, dev, urls/)
  bad({'registry.d/a.yaml': 'dios:\n  mount: Not/Ok\n'}, /mount "Not\/Ok" is not a path segment/)
  bad({'registry.d/a.yaml': 'Dios:\n  mount: a\n'}, /"Dios" is not a link key/)
  bad({'registry.d/a.yaml': 'dios:\n  site: relative/path\n'}, /site "relative\/path" is not an absolute path/)
  bad({'registry.d/a.yaml': 'dios:\n  dev: localhost:8101\n'}, /dev is not an http or https address/)
  bad({'registry.d/a.yaml': 'dios: [a, b]\n'}, /dios is not a map of fields/)
  bad({'registry.d/a.yaml': 'dios:\n  mount: a\n bad: indent\n'}, /a\.yaml:\d+:/)
  bad({'targets.yaml': 'local:\n  url: x\n'}, /target "local" has no base/)
  bad({'targets.yaml': 'local:\n  base: ftp://x\n'}, /target "local": the base .* scheme other than http/)
  bad({'targets.yaml': TARGETS, 'default-target': 'nope\n'}, /default-target names "nope", and targets\.yaml has local, public/)
})

test('overrides win per field and per target, and cannot reach a target they were not made for', () => {
  const dir = config({
    'targets.yaml': TARGETS,
    'registry.d/shelton.yaml': SHELTON,
    'overrides.d/90-testing.yaml': '# testing a copy of dios on :9000\ndios:\n  urls:\n    local: http://localhost:9000/dios/\n  dev: http://localhost:8101\n',
  })
  const machine = loadMachine({dir})
  const dios = machine.wikis.get('dios')
  assert.equal(dios.mount, 'shelton', 'a field the override did not name is untouched')
  assert.equal(dios.dev, 'http://localhost:8101')
  assert.equal(dios.from.dev, join(dir, 'overrides.d', '90-testing.yaml'), 'and says where it came from')
  assert.equal(dios.from.mount, join(dir, 'registry.d', 'shelton.yaml'))

  const local = machine.targets.get('local')
  const pub = machine.targets.get('public')
  assert.equal(addressOf(dios, local), 'http://localhost:9000/dios', 'the override applies to the target it names')
  assert.equal(addressOf(dios, pub), 'https://example.org/docs/shelton/dios', 'and not to the others')

  const registryOnly = machine.registry.get('dios')
  assert.equal(registryOnly.dev, undefined, 'the registry layer is kept apart from the merged one')
})

test('an override can describe a wiki that exists only as an address', () => {
  const machine = loadMachine({
    dir: config({'targets.yaml': TARGETS, 'overrides.d/partner.yaml': 'partner:\n  urls:\n    public: https://partner.example.org/docs/\n'}),
  })
  const partner = machine.wikis.get('partner')
  assert.equal(addressOf(partner, machine.targets.get('public')), 'https://partner.example.org/docs')
  assert.equal(addressOf(partner, machine.targets.get('local')), undefined, 'no address for a target it has none for')
})

test('the plugin is given an address and an index for each wiki, for the target being built', () => {
  const dir = config({'targets.yaml': TARGETS, 'default-target': 'local', 'registry.d/shelton.yaml': SHELTON})
  const machine = loadMachine({dir})
  const target = {...machine.targets.get('local')}

  // A release for the target, in the place a build for an explicit base puts it.
  const index = join('/home/me/shelton-dios/wiki/site', 'releases', target.slug, 'static', 'contentIndex.json')
  const registry = pluginRegistry(machine, {target})
  assert.equal(registry.dios.published, 'http://localhost:8088/wikis/shelton/dios')
  assert.equal(registry.dios.dev, 'http://localhost:8088/wikis/shelton/dios', 'with no dev address a dev server links to the default target')
  assert.equal(registry.dios.publishedIndex, undefined, 'and with no release on disk there is no index to name')
  void index

  // A target that is not named, built for a project served at its own base, takes no part in the layout.
  const legacy = pluginRegistry(machine, {target: {base: 'https://wiki.example.org', slug: 'wiki-example-org', mount: null, targetName: null}})
  assert.equal(legacy.dios.published, undefined)
})

test('the way back to every wiki is the base of the target built for, else the default one', () => {
  const dir = config({'targets.yaml': TARGETS, 'default-target': 'local\n'})
  const machine = loadMachine({dir})
  const mounted = {...machine.targets.get('public'), mount: 'shelton', name: 'dios'}
  assert.equal(homeFor(mounted, {dir}), 'https://example.org/docs/', 'a build for a target: its base, not the default')
  assert.equal(homeFor({base: 'https://wiki.example.org', mount: null}, {dir}), null, 'a wiki served at its own base has nothing above it')
  assert.equal(homeFor(null, {dir}), 'http://localhost:8088/wikis/', 'a dev server: the default target')
  assert.equal(homeFor(null, {dir: config({'targets.yaml': TARGETS})}), null, 'no default target, no page to go back to')
  assert.equal(homeFor(null, {dir: join(tmpdir(), 'awt-machine-absent-' + process.pid)}), null, 'and no configuration at all')
})

test('a release is found where an explicit build puts it, or where the declared one records its address', () => {
  const site = mkdtempSync(join(tmpdir(), 'awt-machine-site-'))
  made.push(site)
  const entry = {mount: 'm', name: 'n', site}
  const t = {targetName: 'local', base: 'http://localhost:8088/wikis', slug: 'localhost-8088-wikis'}
  const url = 'http://localhost:8088/wikis/m/n'
  const put = (dir, record) => {
    mkdirSync(join(dir, 'static'), {recursive: true})
    writeFileSync(join(dir, 'static', 'contentIndex.json'), '{}')
    if (record) writeFileSync(join(dir, 'static', 'awtRelease.json'), JSON.stringify(record))
  }

  assert.equal(releaseFor(entry, t, url), undefined, 'no release yet')
  put(join(site, 'release'), {url: 'https://example.org/x'})
  assert.equal(releaseFor(entry, t, url), undefined, 'a standing release built for another address is not this one')
  put(join(site, 'release'), {url})
  assert.equal(releaseFor(entry, t, url), join(site, 'release'))
  put(join(site, 'releases', t.slug))
  assert.equal(releaseFor(entry, t, url), join(site, 'releases', t.slug), 'a site published before build/ is still found where it was')
  put(join(site, 'build', 'published', t.slug))
  assert.equal(releaseFor(entry, t, url), join(site, 'build', 'published', t.slug), 'and one in build/published wins over both')
})

test('a wiki\'s dev index is in build/dev, or in public where an older serve put it', () => {
  const dir = config({'targets.yaml': TARGETS})
  const site = mkdtempSync(join(tmpdir(), 'awt-machine-dev-'))
  made.push(site)
  const wiki = {key: 'x', mount: 'm', name: 'n', site, dev: 'http://localhost:8101'}
  const machine = {defaultTarget: null, targets: new Map(), wikis: new Map([['x', wiki]])}
  const where = () => pluginRegistry(machine).x.buildIndex

  assert.equal(where(), join(site, 'build', 'dev', 'static', 'contentIndex.json'), 'nothing built yet: where it will be')
  mkdirSync(join(site, 'public', 'static'), {recursive: true})
  writeFileSync(join(site, 'public', 'static', 'contentIndex.json'), '{}')
  assert.equal(where(), join(site, 'public', 'static', 'contentIndex.json'), 'an older dev build is found')
  mkdirSync(join(site, 'build', 'dev', 'static'), {recursive: true})
  writeFileSync(join(site, 'build', 'dev', 'static', 'contentIndex.json'), '{}')
  assert.equal(where(), join(site, 'build', 'dev', 'static', 'contentIndex.json'), 'and the new one wins once there is one')
  void dir
})

test('registering writes the wiki into its mount\'s file, keeps what a person wrote there, and is idempotent', () => {
  const dir = config({'targets.yaml': TARGETS})
  const entry = {mount: 'shelton', name: 'dios', site: '/home/me/shelton-dios/wiki/site'}

  const first = registerWiki({dir, key: 'dios', entry})
  assert.deepEqual([first.changed, first.created], [true, true])
  const file = join(dir, 'registry.d', 'shelton.yaml')
  assert.match(readFileSync(file, 'utf8'), /^# Wikis under the "shelton" mount, written by awt site register\./)

  // A person annotates the file; a second wiki is registered beside the first.
  writeFileSync(file, readFileSync(file, 'utf8').replace('dios:', '# the main app\ndios:'))
  const second = registerWiki({dir, key: 'photo-cli', entry: {mount: 'shelton', name: 'photo-cli', site: '/home/me/photo-cli/wiki/site'}})
  assert.deepEqual([second.changed, second.created], [true, false])
  const text = readFileSync(file, 'utf8')
  assert.match(text, /# the main app\ndios:/, 'the comment a person added survives')
  assert.match(text, /photo-cli:\n {2}mount: shelton/)

  assert.equal(registerWiki({dir, key: 'dios', entry}).changed, false, 'registering what is registered changes nothing')
  assert.deepEqual([...loadMachine({dir}).wikis.keys()], ['dios', 'photo-cli'])
})

test('a different entry needs --force, another mount is refused, and a taken address is refused', () => {
  const dir = config({'targets.yaml': TARGETS})
  const entry = {mount: 'shelton', name: 'dios', site: '/a/site'}
  registerWiki({dir, key: 'dios', entry})

  assert.throws(() => registerWiki({dir, key: 'dios', entry: {...entry, site: '/b/site'}}), /registered differently .* \(site\)\. Pass --force/)
  assert.equal(registerWiki({dir, key: 'dios', entry: {...entry, site: '/b/site'}, force: true}).changed, true)
  assert.equal(loadMachine({dir}).wikis.get('dios').site, '/b/site')

  assert.throws(() => registerWiki({dir, key: 'dios', entry: {...entry, mount: 'other'}}), /registered in .*shelton\.yaml\. Run awt site unregister dios/)
  assert.throws(() => registerWiki({dir, key: 'another', entry}), /"dios" is already shelton\/dios/)
  assert.throws(() => registerWiki({dir, key: 'x', entry: {mount: 'm'}}), /needs a mount and a name/)
  assert.throws(() => registerWiki({dir, key: 'Bad Key', entry}), /not a link key/)
})

test('a dry run says what would change and writes nothing', () => {
  const dir = config({'targets.yaml': TARGETS})
  const result = registerWiki({dir, key: 'dios', entry: {mount: 'shelton', name: 'dios', site: '/a/site'}, dryRun: true})
  assert.deepEqual([result.changed, result.dryRun], [true, true])
  assert.ok(!existsSync(join(dir, 'registry.d')), 'nothing was written')

  registerWiki({dir, key: 'dios', entry: {mount: 'shelton', name: 'dios', site: '/a/site'}})
  assert.equal(unregisterWiki({dir, key: 'dios', dryRun: true}).fileRemoved, true)
  assert.ok(existsSync(join(dir, 'registry.d', 'shelton.yaml')), 'a dry run left the file')
})

test('unregistering removes the entry, and the file when it held no other wiki', () => {
  const dir = config({'targets.yaml': TARGETS, 'registry.d/shelton.yaml': SHELTON})
  const file = join(dir, 'registry.d', 'shelton.yaml')

  const first = unregisterWiki({dir, key: 'dios'})
  assert.deepEqual([first.removed, first.fileRemoved], [true, false])
  assert.match(readFileSync(file, 'utf8'), /# Shelton wikis/, 'the rest of the file, comments included, is kept')
  assert.ok(!readFileSync(file, 'utf8').includes('dios:'))
  assert.match(readFileSync(file, 'utf8'), /^# Shelton wikis\n/, 'a comment above the first entry becomes the file\'s header, not lost with the entry')

  assert.equal(unregisterWiki({dir, key: 'photo-cli'}).fileRemoved, true)
  assert.ok(!existsSync(file))
  assert.throws(() => unregisterWiki({dir, key: 'photo-cli'}), /"photo-cli" is not registered/)
})

test('the wikis are described with an address per target and the file of each field', () => {
  const dir = config({'targets.yaml': TARGETS, 'default-target': 'public', 'registry.d/shelton.yaml': SHELTON})
  const view = describeMachine(loadMachine({dir}), 'dios')
  assert.equal(view.wikis.length, 1)
  assert.deepEqual(view.wikis[0].addresses, {
    local: 'http://localhost:8088/wikis/shelton/dios/',
    public: 'https://example.org/docs/shelton/dios/',
  })
  assert.deepEqual(
    view.targets.map((t) => [t.name, t.default]),
    [['local', false], ['public', true]],
  )
})

// ------------------------------------------------------------------- which target a build is for

test('a named target supplies the base, and a wiki under it needs a mount', () => {
  const dir = config({'targets.yaml': TARGETS})
  const plan = (values, declaration = {}, env = {}) => planRelease(values, '/p/site', declaration, {env, dir})

  const named = plan({target: 'public', mount: 'shelton', name: 'dios'})
  assert.equal(named.target.url, 'https://example.org/docs/shelton/dios')
  assert.equal(named.target.targetName, 'public')
  assert.equal(named.out, join('/p/site', 'build', 'published', 'example-org-docs'), 'a named target lands in build/published/<base>')

  assert.match(refusal(() => plan({target: 'public'}, {self: 'dios'})), /hosts several wikis, so this one needs a mount/)
  assert.equal(plan({target: 'public'}, {self: 'dios', mount: 'shelton'}).target.url, 'https://example.org/docs/shelton/dios', 'site.mount and site.self supply the rest')
  assert.match(refusal(() => plan({target: 'nope'})), /no target "nope" in .*targets\.yaml; it has local, public/)
})

test('without a base the target is $AWT_TARGET, then site.target, then the default; a base needs none', () => {
  const dir = config({'targets.yaml': TARGETS, 'default-target': 'local\n'})
  const declared = {self: 'dios', mount: 'shelton'}
  const plan = (values, declaration, env = {}) => planRelease(values, '/p/site', {...declared, ...declaration}, {env, dir}).target

  assert.equal(plan({}, {}).targetName, 'local', 'the default-target file')
  assert.equal(plan({}, {target: 'public'}).targetName, 'public', 'site.target over the file')
  assert.equal(plan({}, {target: 'public'}, {AWT_TARGET: 'local'}).targetName, 'local', '$AWT_TARGET over site.target')
  assert.equal(plan({target: 'public'}, {}, {AWT_TARGET: 'local'}).targetName, 'public', 'and --target over both')

  const standing = plan({}, {baseUrl: 'wiki.example.org'}, {AWT_TARGET: 'local'})
  assert.equal(standing.targetName, undefined, 'a declared base is the standing target and no machine default overrides it')
  assert.equal(standing.url, 'https://wiki.example.org/shelton/dios')
})

test('two answers to where a release is served from are refused, not ranked', () => {
  const dir = config({'targets.yaml': TARGETS})
  const plan = (values, declaration = {}) => planRelease(values, '/p/site', declaration, {env: {}, dir})
  assert.match(refusal(() => plan({target: 'local', base: 'https://x.org'})), /--target and --base both say where/)
  assert.match(refusal(() => plan({}, {target: 'local', baseUrl: 'x.org'})), /site\.target and site\.baseUrl both say where/)
})

test('a machine with no targets file has no target, and the build goes in published/default', () => {
  const dir = join(tmpdir(), 'awt-machine-none-' + process.pid)
  const plan = planRelease({}, '/p/site', {self: 'dios'}, {env: {}, dir})
  assert.equal(plan.target, null)
  assert.equal(plan.out, join('/p/site', 'build', 'published', 'default'))
})

// ---------------------------------------------- a wiki that does not name itself is named by its registration

/** A registered wiki's site directory, a configuration for it, and the plan for a build of it. */
function registered() {
  const cfg = config({'targets.yaml': TARGETS})
  const site = mkdtempSync(join(tmpdir(), 'awt-machine-reg-'))
  made.push(site)
  mkdirSync(join(cfg, 'registry.d'))
  writeFileSync(join(cfg, 'registry.d', 'shelton.yaml'), `dios:\n  mount: shelton\n  name: dios\n  site: ${site}\n`)
  const plan = (values, declaration = {}) => planRelease(values, site, declaration, {env: {}, dir: cfg})
  return {plan, site, cfg}
}

test('a named target uses the mount and name the machine registered, and the declaration still wins', () => {
  const {plan} = registered()
  const named = plan({target: 'local'})
  assert.equal(named.target.url, 'http://localhost:8088/wikis/shelton/dios')
  assert.equal(named.registered.key, 'dios', 'and the registration is handed back, for the wiki\'s own prefix')

  assert.equal(plan({target: 'local'}, {mount: 'other', self: 'renamed'}).target.url, 'http://localhost:8088/wikis/other/renamed', 'declared identity beats registered')
  assert.equal(plan({target: 'local', mount: 'm'}).target.url, 'http://localhost:8088/wikis/m/dios', 'a flag beats both, per field')
})

test('a base on the command line takes the registration too, and a declared base is left where it was', () => {
  const {plan} = registered()
  assert.equal(plan({base: 'https://example.org/docs'}).target.url, 'https://example.org/docs/shelton/dios')
  const standing = plan({}, {baseUrl: 'wiki.example.org'})
  assert.equal(standing.target.url, 'https://wiki.example.org', 'a project served at its own base is not moved under a mount by registering it')
  assert.equal(standing.registered, null)
})

test('a wiki the machine has not registered gets no identity from it', () => {
  const cfg = config({'targets.yaml': TARGETS})
  const plan = (values) => planRelease(values, '/not/registered/site', {}, {env: {}, dir: cfg})
  assert.match(refusal(() => plan({target: 'local'})), /hosts several wikis, so this one needs a mount/)
})
