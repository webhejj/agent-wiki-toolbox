/**
 * The machine layer: what `~/.config/awt/` says, its libraries, how they are checked, and what they become.
 *
 * Every test writes a configuration directory of its own and passes it in, so nothing reads or
 * writes the real one. `die` throws, which is the behaviour under test where a file is refused.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync} from 'node:fs'
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
  migrateMachine,
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

const LOCAL = `# my wikis
base: http://localhost:8088/wikis
title: Wikis here
deploy:
  to: ~/.local/share/awt/libraries/local/
collections:
  tools:
    path: tools
    title: Tools
    wikis:
      aisandbox:
        site: /home/me/AiSandbox/wiki/site
  shelton:
    path: clients/shelton
    title: Shelton
    wikis:
      # the main app
      shelton-dios:
        name: dios
        site: /home/me/shelton-dios/wiki/site
      photo-cli:
        site: /home/me/photo-cli/wiki/site
`
const PUBLIC = `base: https://example.org/docs
access:
  allow:
    - 10.0.0.0/24
  basic: admin
trusted-proxies:
  - 10.0.0.100
deploy:
  to: proton:/opt/docker/awt-wikis/
collections:
  shelton:
    path: shelton
    title: Shelton
    wikis:
      shelton-dios:
        site: /home/me/shelton-dios/wiki/site
        repo: git@github.com:x/shelton-dios.git
        path: wiki
  elsewhere:
    path: elsewhere
    wikis:
      partner:
        repo: git@github.com:x/partner.git
        path: docs
`
const BOTH = {'awt.yaml': 'default-library: local\n', 'libraries/local.yaml': LOCAL, 'libraries/public.yaml': PUBLIC}

test('the directory is $AWT_CONFIG_DIR, else awt under the platform\'s config directory', () => {
  assert.equal(configDir({AWT_CONFIG_DIR: '/x/y'}, 'linux'), '/x/y')
  assert.equal(configDir({XDG_CONFIG_HOME: '/xdg'}, 'linux'), '/xdg/awt')
  assert.equal(configDir({APPDATA: 'C:\\Users\\me\\AppData\\Roaming'}, 'win32').endsWith('awt'), true)
  assert.equal(expandHome('~/a/b', '/h'), '/h/a/b')
  assert.equal(tildeHome('/h/a/b', '/h'), '~/a/b')
  assert.equal(tildeHome('/elsewhere/a', '/h'), '/elsewhere/a')
})

test('libraries, the default, and each wiki load, with its membership in every library', () => {
  const dir = config(BOTH)
  const machine = loadMachine({dir})
  assert.deepEqual([...machine.targets.keys()], ['local', 'public'], 'a library is named by its file')
  const local = machine.targets.get('local')
  assert.deepEqual([local.base, local.slug, local.title], ['http://localhost:8088/wikis', 'localhost-8088-wikis', 'Wikis here'])
  assert.deepEqual(local.collections.map((c) => [c.key, c.path, c.members]), [['tools', 'tools', ['aisandbox']], ['shelton', 'clients/shelton', ['shelton-dios', 'photo-cli']]])
  assert.equal(local.deploy.path.endsWith('/.local/share/awt/libraries/local/'), true)
  const pub = machine.targets.get('public')
  assert.deepEqual(pub.access, {allow: ['10.0.0.0/24'], basic: 'admin'})
  assert.deepEqual(pub.trustedProxies, ['10.0.0.100'])
  assert.deepEqual(pub.deploy, {remote: true, host: 'proton', path: '/opt/docker/awt-wikis/', spec: 'proton:/opt/docker/awt-wikis/'})
  assert.equal(pub.collections[1].title, 'elsewhere', 'a collection with no title is titled by its key')

  assert.equal(machine.defaultTarget, 'local')
  assert.deepEqual(machine.groupOrder, ['Tools', 'Shelton'])
  const dios = machine.wikis.get('shelton-dios')
  assert.deepEqual([dios.mount, dios.name, dios.group, dios.site], ['clients/shelton', 'dios', 'Shelton', '/home/me/shelton-dios/wiki/site'], 'its own identity is the default library\'s')
  assert.deepEqual([dios.libraries.public.mount, dios.libraries.public.name, dios.libraries.public.repo], ['shelton', 'shelton-dios', 'git@github.com:x/shelton-dios.git'])
  assert.equal(dios.from.site, join(dir, 'libraries', 'local.yaml'))
  assert.equal(machine.wikis.get('partner').site, undefined, 'a wiki with a repo and no checkout here')
})

test('a machine with no configuration is not an error, and says nothing', () => {
  const dir = join(tmpdir(), 'awt-machine-absent-' + process.pid)
  assert.equal(loadMachineIfPresent({dir}), null)
  assert.equal(readDefaultTarget(dir), null)
  const empty = loadMachine({dir: config()})
  assert.equal(empty.targets.size + empty.wikis.size, 0)
})

test('a collision is an error naming both places, never a quiet override', () => {
  const lib = (collections) => config({'libraries/l.yaml': `base: https://x.org\ncollections:\n${collections}`})
  const wikis = (...keys) => `    wikis:\n${keys.map((k) => `      ${k}:\n        site: /s/${k}\n`).join('')}`
  assert.throws(() => loadMachine({dir: lib(`  a:\n    path: a\n${wikis('dios')}  b:\n    path: b\n${wikis('dios')}`)}), /"dios" is in collections a and b/)
  assert.throws(() => loadMachine({dir: lib(`  a:\n    path: x\n  b:\n    path: x\n`)}), /collections a and b are both at x/)
  assert.throws(() => loadMachine({dir: lib(`  a:\n    path: x\n  b:\n    path: x/y\n`)}), /a at x and b at x\/y are one inside the other/)
  assert.throws(() => loadMachine({dir: lib(`  a:\n    path: a\n    wikis:\n      one:\n        name: n\n        site: /s/1\n      two:\n        name: n\n        site: /s/2\n`)}), /"one" and "two" are both at a\/n\//)
  assert.throws(() => loadMachine({dir: lib(`  a:\n    path: a\n${wikis('dios')}  a:\n    path: b\n`)}), /l\.yaml:\d+: a key appears twice/)

  const two = config({
    'libraries/a.yaml': 'base: https://a.org\ncollections:\n  c:\n    path: c\n    wikis:\n      dios:\n        site: /one/site\n',
    'libraries/b.yaml': 'base: https://b.org\ncollections:\n  c:\n    path: c\n    wikis:\n      dios:\n        site: /two/site\n',
  })
  assert.throws(() => loadMachine({dir: two}), /"dios" has site \/two\/site in .*b\.yaml and \/one\/site in .*a\.yaml; one wiki is one checkout/)
})

test('what is wrong with a file is said with the file, the key and the field', () => {
  const bad = (library, pattern, extra = {}) => assert.throws(() => loadMachine({dir: config({'libraries/l.yaml': library, ...extra})}), pattern)
  const member = (fields) => `base: https://x.org\ncollections:\n  c:\n    path: c\n    wikis:\n      dios:\n${fields}`
  bad(member('        sight: /x\n'), /l\.yaml: collection c: dios has a field "sight"; the fields are name, site, dev, repo, path/)
  bad(member('        name: Not/Ok\n        site: /x\n'), /name "Not\/Ok" is not a path segment/)
  bad('base: https://x.org\ncollections:\n  c:\n    path: c\n    wikis:\n      Dios:\n        site: /x\n', /"Dios" is not a link key/)
  bad(member('        site: relative/path\n'), /site "relative\/path" is not an absolute path/)
  bad(member('        site: /x\n        dev: localhost:8101\n'), /dev is not an http or https address/)
  bad(member('        name: dios\n'), /has neither a site nor a repo/)
  bad(member('        site: /x\n        path: wiki\n'), /has a path and no repo/)
  bad('base: https://x.org\ncollections:\n  c:\n    path: Not Ok\n', /collection c path "Not Ok" is not a path/)
  bad('base: https://x.org\naccess:\n  allow:\n    - 10.0.0.0/33\n', /access allow: "10\.0\.0\.0\/33" is not an address or a CIDR range/)
  bad('base: https://x.org\naccess:\n  basic: ../etc/passwd\n', /basic "\.\.\/etc\/passwd" is not the name of an htpasswd file/)
  bad('base: https://x.org\nbse: x\n', /l\.yaml has a field "bse"/)
  bad('title: x\n', /the library has no base/)
  bad('base: ftp://x\n', /l\.yaml: the base .* scheme other than http/)
  bad('base: https://x.org\n', /awt\.yaml names "nope", and .*libraries has l/, {'awt.yaml': 'default-library: nope\n'})
})

test('a wiki\'s address is its collection path and name in the library being built', () => {
  const machine = loadMachine({dir: config(BOTH)})
  const local = machine.targets.get('local')
  const pub = machine.targets.get('public')
  const dios = machine.wikis.get('shelton-dios')
  assert.equal(addressOf(dios, local), 'http://localhost:8088/wikis/clients/shelton/dios')
  assert.equal(addressOf(dios, pub), 'https://example.org/docs/shelton/shelton-dios', 'another library, another collection and name')
  assert.equal(addressOf(machine.wikis.get('aisandbox'), pub), undefined, 'a wiki the library does not hold has no address in it')
  assert.equal(addressOf(dios, {base: 'https://y.org'}), 'https://y.org/clients/shelton/dios', 'a bare base takes the default library\'s layout')
})

test('the plugin is given an address and an index for each wiki, for the library being built', () => {
  const machine = loadMachine({dir: config(BOTH)})
  const registry = pluginRegistry(machine, {target: machine.targets.get('public')})
  assert.equal(registry['shelton-dios'].published, 'https://example.org/docs/shelton/shelton-dios')
  assert.equal(registry['shelton-dios'].dev, 'http://localhost:8088/wikis/clients/shelton/dios', 'with no dev address a dev server links to the default library')
  assert.equal(registry['shelton-dios'].publishedIndex, undefined, 'and with no release on disk there is no index to name')
  assert.equal(registry.aisandbox.published, undefined, 'a wiki the library does not hold is left out of its half')

  // A build for a project served at its own base takes no part in the layout.
  const own = pluginRegistry(machine, {target: {base: 'https://wiki.example.org', slug: 'wiki-example-org', mount: null, targetName: null}})
  assert.equal(own['shelton-dios'].published, undefined)
})

test('the way back to every wiki is the base of the library built for, else the default one', () => {
  const dir = config(BOTH)
  const machine = loadMachine({dir})
  const mounted = {...machine.targets.get('public'), mount: 'shelton', name: 'dios'}
  assert.equal(homeFor(mounted, {dir}), 'https://example.org/docs/', 'a build for a library: its base, not the default')
  assert.equal(homeFor({base: 'https://wiki.example.org', mount: null}, {dir}), null, 'a wiki served at its own base has nothing above it')
  assert.equal(homeFor(null, {dir}), 'http://localhost:8088/wikis/', 'a dev server: the default library')
  assert.equal(homeFor(null, {dir: config({'libraries/public.yaml': PUBLIC})}), null, 'no default library, no page to go back to')
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
})

test('registering writes the wiki into its collection, keeps what a person wrote, block style, and is idempotent', () => {
  const dir = config(BOTH)
  const file = join(dir, 'libraries', 'local.yaml')
  const entry = {site: '/home/me/ghostbusters/wiki/site'}

  const first = registerWiki({dir, library: 'local', collection: 'tools', key: 'ghostbusters', entry})
  assert.equal(first.changed, true)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^# my wikis\n/, 'the header a person wrote survives')
  assert.match(text, /# the main app\n {6}shelton-dios:/, 'and so does a comment on another entry')
  assert.match(text, /aisandbox:\n {8}site: \/home\/me\/AiSandbox\/wiki\/site\n {6}ghostbusters:\n {8}site: \/home\/me\/ghostbusters\/wiki\/site\n/, 'appended in block style')
  assert.doesNotMatch(text, /[{[]/, 'no flow style anywhere')

  assert.equal(registerWiki({dir, library: 'local', collection: 'tools', key: 'ghostbusters', entry}).changed, false, 'registering what is registered changes nothing')
  assert.deepEqual(loadMachine({dir}).targets.get('local').collections[0].members, ['aisandbox', 'ghostbusters'])

  registerWiki({dir, library: 'public', collection: 'elsewhere', key: 'ghostbusters', entry: {...entry, repo: 'git@github.com:x/g.git', path: 'wiki'}})
  assert.match(readFileSync(join(dir, 'libraries', 'public.yaml'), 'utf8'), /ghostbusters:\n {8}site: .*\n {8}repo: git@github\.com:x\/g\.git\n {8}path: wiki\n/)
})

test('a different entry needs force, another collection is refused, and a taken address is refused', () => {
  const dir = config({'awt.yaml': 'default-library: local\n', 'libraries/local.yaml': LOCAL})
  const reg = (args) => registerWiki({dir, library: 'local', collection: 'shelton', ...args})
  const dios = {name: 'dios', site: '/home/me/shelton-dios/wiki/site'}

  assert.throws(() => reg({key: 'shelton-dios', entry: {...dios, site: '/b/site'}}), /registered differently .* \(site\)\. Pass --force/)
  assert.equal(reg({key: 'shelton-dios', entry: {...dios, site: '/b/site'}, force: true}).changed, true)
  assert.equal(loadMachine({dir}).wikis.get('shelton-dios').site, '/b/site')

  assert.throws(() => registerWiki({dir, library: 'local', collection: 'tools', key: 'shelton-dios', entry: dios}), /in the collection shelton of .*local\.yaml\. Run awt site unregister shelton-dios --library local/)
  assert.throws(() => reg({key: 'another', entry: {name: 'dios', site: '/c/site'}}), /"shelton-dios" is already at clients\/shelton\/dios\//)
  assert.throws(() => reg({key: 'x', entry: {name: 'x'}}), /has neither a site nor a repo/)
  assert.throws(() => reg({key: 'Bad Key', entry: dios}), /not a link key/)
  assert.throws(() => registerWiki({dir, library: 'local', collection: 'nope', key: 'x', entry: dios}), /has no collection "nope"; it has tools, shelton\. Add it/)
  assert.throws(() => registerWiki({dir, library: 'nope', collection: 'tools', key: 'x', entry: dios}), /no library "nope" .*; it has local\./)
})

test('a dry run says what would change and writes nothing', () => {
  const dir = config(BOTH)
  const file = join(dir, 'libraries', 'local.yaml')
  const before = readFileSync(file, 'utf8')
  const result = registerWiki({dir, library: 'local', collection: 'tools', key: 'x', entry: {site: '/x/site'}, dryRun: true})
  assert.deepEqual([result.changed, result.dryRun], [true, true])
  assert.equal(unregisterWiki({dir, library: 'local', key: 'aisandbox', dryRun: true}).removed, true)
  assert.equal(readFileSync(file, 'utf8'), before, 'nothing was written')
})

test('unregistering removes the entry from its collection and keeps the rest of the file', () => {
  const dir = config(BOTH)
  const file = join(dir, 'libraries', 'local.yaml')
  const result = unregisterWiki({dir, library: 'local', key: 'photo-cli'})
  assert.deepEqual([result.removed, result.collection], [true, 'shelton'])
  const text = readFileSync(file, 'utf8')
  assert.ok(!text.includes('photo-cli'))
  assert.match(text, /# the main app\n {6}shelton-dios:/, 'comments stay')
  assert.throws(() => unregisterWiki({dir, library: 'local', key: 'photo-cli'}), /"photo-cli" is not in the library local/)
})

test('the wikis are described with an address per library', () => {
  const view = describeMachine(loadMachine({dir: config(BOTH)}), 'shelton-dios')
  assert.equal(view.wikis.length, 1)
  assert.deepEqual(view.wikis[0].addresses, {
    local: 'http://localhost:8088/wikis/clients/shelton/dios/',
    public: 'https://example.org/docs/shelton/shelton-dios/',
  })
  assert.deepEqual(view.targets.map((t) => [t.name, t.default, t.deploy]), [['local', true, '~/.local/share/awt/libraries/local/'], ['public', false, 'proton:/opt/docker/awt-wikis/']])
})

test('each library\'s release is described as fresh, stale or unbuilt against the notes beside it', () => {
  const home = config({'notes/a.md': '# A\n'})
  const release = (slug, at) => {
    const dir = join(home, 'site', 'build', 'published', slug)
    mkdirSync(join(dir, 'static'), {recursive: true})
    writeFileSync(join(dir, 'static', 'contentIndex.json'), '{}')
    writeFileSync(join(dir, 'static', 'awtRelease.json'), JSON.stringify({builtAt: at}))
  }
  release('localhost-8088-wikis', '2026-10-30T12:00:00.000Z')
  release('example-org-docs', '2026-10-30T10:00:00.000Z')
  const edited = new Date('2026-10-30T11:00:00.000Z')
  utimesSync(join(home, 'notes', 'a.md'), edited, edited)
  const member = `    wikis:\n      a:\n        site: ${join(home, 'site')}\n`
  const dir = config({
    'awt.yaml': 'default-library: local\n',
    'libraries/local.yaml': `base: http://localhost:8088/wikis\ncollections:\n  tools:\n    path: tools\n${member}`,
    'libraries/public.yaml': `base: https://example.org/docs\ncollections:\n  tools:\n    path: tools\n${member}`,
    'libraries/elsewhere.yaml': 'base: https://elsewhere.org\ncollections:\n  tools:\n    path: tools\n    wikis:\n      a:\n        site: ' + join(home, 'site') + '\n',
  })
  const [a] = describeMachine(loadMachine({dir}), 'a').wikis
  assert.deepEqual(a.releases, {
    local: {state: 'fresh', builtAt: '2026-10-30T12:00:00.000Z'},
    public: {state: 'stale', builtAt: '2026-10-30T10:00:00.000Z'},
    elsewhere: {state: 'unbuilt', builtAt: null},
  })
})

// ------------------------------------------------------------------- the config from before libraries

test('the config from before libraries is lifted into one library per target, and the old files kept', async () => {
  const dir = config({
    'targets.yaml': 'local:\n  base: http://localhost:8088/wikis\npublic:\n  base: https://example.org/docs\n',
    'default-target': 'local\n',
    'groups': 'Tools\nShelton\n',
    'registry.d/shelton.yaml': 'dios:\n  mount: shelton\n  name: dios\n  site: /home/me/dios/wiki/site\n',
    'registry.d/tools.yaml': 'aisandbox:\n  mount: aisandbox\n  name: aisandbox\n  site: /home/me/AiSandbox/wiki/site\n',
    'overrides.d/groups.yaml': 'dios: {group: Shelton}\naisandbox: {group: Tools}\npartner:\n  urls:\n    public: https://partner.example.org/\n',
  })
  const dry = await migrateMachine({dir, dryRun: true})
  assert.deepEqual(Object.keys(dry.files).sort(), ['awt.yaml', join('libraries', 'local.yaml'), join('libraries', 'public.yaml')])
  assert.deepEqual(dry.skipped.map((s) => s.key), ['partner'])
  assert.ok(!existsSync(join(dir, 'awt.yaml')), 'a dry run wrote nothing')

  await migrateMachine({dir})
  const machine = loadMachine({dir})
  assert.equal(machine.defaultTarget, 'local')
  assert.deepEqual(machine.targets.get('local').collections.map((c) => [c.key, c.path, c.title, c.members]), [['tools', 'tools', 'Tools', ['aisandbox']], ['shelton', 'shelton', 'Shelton', ['dios']]])
  assert.ok(machine.targets.get('local').deploy, 'a local target deploys to a directory')
  assert.equal(machine.targets.get('public').deploy, null, 'a remote one is left for a person to say where')
  assert.equal(addressOf(machine.wikis.get('dios'), machine.targets.get('public')), 'https://example.org/docs/shelton/dios')
  assert.ok(existsSync(join(dir, 'legacy', 'registry.d', 'shelton.yaml')) && !existsSync(join(dir, 'targets.yaml')))
  await assert.rejects(migrateMachine({dir}), /no targets\.yaml, registry\.d or overrides\.d to migrate/)
})

// ------------------------------------------------------------------- which library a build is for

/** A wiki's site directory in a library, a configuration for it, and the plan for a build of it. */
function registered(extra = {}) {
  const site = mkdtempSync(join(tmpdir(), 'awt-machine-reg-'))
  made.push(site)
  const cfg = config({
    'awt.yaml': 'default-library: local\n',
    'libraries/local.yaml': `base: http://localhost:8088/wikis\ncollections:\n  shelton:\n    path: clients/shelton\n    wikis:\n      shelton-dios:\n        name: dios\n        site: ${site}\n`,
    'libraries/public.yaml': `base: https://example.org/docs\ncollections:\n  s:\n    path: shelton\n    wikis:\n      shelton-dios:\n        site: ${site}\n`,
    'libraries/empty.yaml': 'base: https://empty.example.org\n',
    ...extra,
  })
  const plan = (values, declaration = {}, env = {}) => planRelease(values, site, declaration, {env, dir: cfg})
  return {plan, site, cfg}
}

test('a named library supplies the base, and the wiki\'s collection and name in it the rest', () => {
  const {plan, site} = registered()
  const local = plan({target: 'local'})
  assert.equal(local.target.url, 'http://localhost:8088/wikis/clients/shelton/dios')
  assert.equal(local.target.targetName, 'local')
  assert.equal(local.registered.key, 'shelton-dios', 'and the registration is handed back, for the wiki\'s own prefix')
  assert.equal(plan({target: 'public'}).target.url, 'https://example.org/docs/shelton/shelton-dios', 'each library its own address')
  assert.equal(plan({target: 'public'}).out, join(site, 'build', 'published', 'example-org-docs'), 'a library lands in build/published/<base>')
  assert.equal(plan({target: 'local', mount: 'm'}).target.url, 'http://localhost:8088/wikis/m/dios', 'a flag beats the library, per field')
  assert.equal(plan({target: 'local'}, {mount: 'other', self: 'renamed'}).target.url, 'http://localhost:8088/wikis/clients/shelton/dios', 'the library beats an old site.mount')

  assert.match(refusal(() => plan({target: 'empty'})), /the library "empty" does not hold this wiki \(shelton-dios\): run awt site register --library empty/)
  assert.match(refusal(() => plan({target: 'nope'})), /no library "nope" in .*libraries; it has empty, local, public/)
})

test('without a base the library is $AWT_LIBRARY or $AWT_TARGET, then site.target, then the default; a base needs none', () => {
  const {plan} = registered()
  assert.equal(plan({}).target.targetName, 'local', 'the default-library')
  assert.equal(plan({}, {target: 'public'}).target.targetName, 'public', 'site.target over the default')
  assert.equal(plan({}, {target: 'public'}, {AWT_TARGET: 'local'}).target.targetName, 'local', '$AWT_TARGET over site.target')
  assert.equal(plan({}, {}, {AWT_LIBRARY: 'public', AWT_TARGET: 'local'}).target.targetName, 'public', '$AWT_LIBRARY over $AWT_TARGET')
  assert.equal(plan({target: 'public'}, {}, {AWT_LIBRARY: 'local'}).target.targetName, 'public', 'and the flag over all')

  const standing = plan({}, {baseUrl: 'wiki.example.org'}, {AWT_LIBRARY: 'local'})
  assert.equal(standing.target.targetName, undefined, 'a declared base is the standing target and no machine default overrides it')
  assert.equal(standing.target.url, 'https://wiki.example.org', 'and a project served at its own base is not moved under a collection')
  assert.equal(standing.registered, null)
  assert.equal(plan({base: 'https://y.org/docs'}).target.url, 'https://y.org/docs/clients/shelton/dios', 'a base on the command line takes the default library\'s layout')
})

test('two answers to where a release is served from are refused, not ranked', () => {
  const {plan} = registered()
  assert.match(refusal(() => plan({target: 'local', base: 'https://x.org'})), /--target and --base both say where/)
  assert.match(refusal(() => plan({}, {target: 'local', baseUrl: 'x.org'})), /site\.target and site\.baseUrl both say where/)
})

test('a machine with no libraries has no target, and the build goes in published/default', () => {
  const dir = join(tmpdir(), 'awt-machine-none-' + process.pid)
  const plan = planRelease({}, '/p/site', {self: 'dios'}, {env: {}, dir})
  assert.equal(plan.target, null)
  assert.equal(plan.out, join('/p/site', 'build', 'published', 'default'))
})

test('a wiki no library holds is refused for a named library', () => {
  const {cfg} = registered()
  const plan = (values) => planRelease(values, '/not/registered/site', {}, {env: {}, dir: cfg})
  assert.match(refusal(() => plan({target: 'local'})), /the library "local" does not hold this wiki: run awt site register/)
})
