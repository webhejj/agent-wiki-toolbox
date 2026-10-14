/**
 * The derived Quartz config, and the migration out of a tracked one.
 *
 * What a project carries about the site is its `site` declaration; the toolbox
 * writes the config Quartz reads. These tests pin the three things that would
 * silently regress: the toolbox's own entry lands with the shape the plugin
 * reads, a project's declaration reaches the right keys, and a tracked file from
 * the old wiring is refused rather than built.
 *
 * `yaml` is loaded out of a fake Quartz install the way the real code loads it,
 * so the tests exercise the same resolution as a build.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test, {after} from 'node:test'

import {deriveSiteConfig, writeSiteConfig, PLUGIN_SOURCE, DERIVED_CONFIG} from '../lib/site-config.js'
import {extractDeclaration, renderDeclaration} from '../lib/migrate.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const made = []
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-siteconf-'))
  made.push(dir)
  return dir
}

/** A Quartz install as far as this code is concerned: yaml, and a default config. */
function fakeQuartz(defaultYaml) {
  const quartz = tmp()
  mkdirSync(join(quartz, 'node_modules'))
  symlinkSync(join(ROOT, 'node_modules', 'yaml'), join(quartz, 'node_modules', 'yaml'))
  writeFileSync(join(quartz, 'quartz.config.default.yaml'), defaultYaml ?? SHIPPED)
  return quartz
}

/** The shape of Quartz's shipped default, cut down to the entries this touches. */
const SHIPPED = [
  'configuration:',
  '  pageTitle: Quartz 5',
  '  analytics:',
  '    provider: plausible',
  '  baseUrl: quartz.jzhao.xyz',
  'plugins:',
  '  - source: "@quartz-community/crawl-links"',
  '    enabled: true',
  '    options:',
  '      markdownLinkResolution: shortest',
  '    order: 60',
  '  - source: "@quartz-community/og-image"',
  '    enabled: true',
  '  - source: "@quartz-community/footer"',
  '    enabled: true',
  '    options:',
  '      links:',
  '        GitHub: https://github.com/jackyzha0/quartz',
  '  - source: "@quartz-community/note-properties"',
  '    enabled: true',
  '    options:',
  '      includeAll: false',
  '      includedProperties: [aliases]',
  '',
].join('\n')

const bySource = (config, name) =>
  config.plugins.find((entry) => String(entry.source).split('/').pop() === name)

const die = (message) => {
  throw new Error(message)
}

test("the base is Quartz's own default with the toolbox's changes on it", async () => {
  const site = tmp()
  const {config, own} = await deriveSiteConfig(site, fakeQuartz(), {}, {port: 8100, die})

  assert.equal(own, false)
  assert.deepEqual(config.configuration.analytics, {provider: null})
  assert.equal(config.configuration.pageTitle, 'wiki')
  assert.equal(config.configuration.baseUrl, 'localhost:8100')
  assert.equal(bySource(config, 'crawl-links').options.disableBrokenWikilinks, true, 'the shadow reads that mark')
  assert.equal(bySource(config, 'crawl-links').options.markdownLinkResolution, 'shortest', 'and the rest is kept')
  assert.equal(bySource(config, 'og-image').enabled, false)
})

test('the toolbox entry names the plugin by absolute path, after crawl-links, with what it reads', async () => {
  const site = tmp()
  const {config} = await deriveSiteConfig(site, fakeQuartz(), {self: 'mine'}, {port: 8101, die})

  const entry = config.plugins.find((one) => one.source === PLUGIN_SOURCE)
  assert.ok(entry, 'no toolbox entry')
  assert.equal(entry.order, 61)
  assert.equal(entry.enabled, true)
  assert.equal(entry.options.index, './build/awt-index.json')
  assert.equal(entry.options.shadow, true)
  assert.equal(entry.options.headings, 'static/awtHeadings.json')
  assert.equal(entry.options.self, 'mine')
  // The wiki's own registry entry is derived from the port and the fixed names.
  assert.deepEqual(entry.options.registry.mine, {
    dev: 'http://localhost:8101',
    buildIndex: './build/dev/static/contentIndex.json',
  })
})

test('the declaration reaches the title, host, registry, properties and footer', async () => {
  const site = tmp()
  const declaration = {
    title: 'DIOS wiki',
    baseUrl: 'wiki.example.org',
    self: 'dios',
    registry: {data: {dev: 'http://localhost:8102', buildIndex: '../../data/site/public/static/contentIndex.json'}},
    properties: ['type', 'status'],
    footer: {Home: 'https://example.org'},
  }

  const served = await deriveSiteConfig(site, fakeQuartz(), declaration, {port: 8101, serving: true, die})
  assert.equal(served.config.configuration.pageTitle, 'DIOS wiki')
  assert.equal(served.config.configuration.baseUrl, 'localhost:8101', 'serving: the dev host, whatever is declared')
  assert.deepEqual(bySource(served.config, 'note-properties').options.includedProperties, ['type', 'status'])
  assert.deepEqual(bySource(served.config, 'footer').options.links, {Home: 'https://example.org'})
  const registry = served.config.plugins.find((one) => one.source === PLUGIN_SOURCE).options.registry
  assert.deepEqual(Object.keys(registry).sort(), ['data', 'dios'])
  assert.equal(registry.data.dev, 'http://localhost:8102', "another wiki's entry passes through as declared")
  assert.equal(registry.dios.published, 'https://wiki.example.org')
  assert.equal(registry.dios.publishedIndex, './build/published/default/static/contentIndex.json')

  const published = await deriveSiteConfig(site, fakeQuartz(), declaration, {port: 8101, serving: false, die})
  assert.equal(published.config.configuration.baseUrl, 'wiki.example.org', 'publishing: the declared host')
})

test('the plugin is told which build it is deriving for, so it does not have to guess from a flag', async () => {
  const site = tmp()
  const optionsOf = (derived) => derived.config.plugins.find((one) => one.source === PLUGIN_SOURCE).options

  const served = await deriveSiteConfig(site, fakeQuartz(), {self: 'dios'}, {port: 8101, serving: true, die})
  const published = await deriveSiteConfig(site, fakeQuartz(), {self: 'dios'}, {port: 8101, serving: false, die})
  assert.equal(optionsOf(served).target, 'dev')
  assert.equal(optionsOf(published).target, 'published')
})

test('the plugin is given the page that lists every wiki, or nothing to link to', async () => {
  const site = tmp()
  const optionsOf = (derived) => derived.config.plugins.find((one) => one.source === PLUGIN_SOURCE).options
  const home = 'http://localhost:8088/wikis/'
  assert.equal(optionsOf(await deriveSiteConfig(site, fakeQuartz(), {}, {port: 8101, home, die})).home, home)
  assert.equal(optionsOf(await deriveSiteConfig(site, fakeQuartz(), {}, {port: 8101, die})).home, null)
})

test('a target sets the base Quartz is told and the address the wiki publishes its own index under', async () => {
  const site = tmp()
  const target = {url: 'http://localhost:8088/wikis/shelton/dios', hostPath: 'localhost:8088/wikis/shelton/dios'}
  const derived = await deriveSiteConfig(site, fakeQuartz(), {self: 'dios'}, {
    port: 8101,
    serving: false,
    target,
    releaseDir: './releases/localhost-8088-wikis',
    die,
  })
  assert.equal(derived.config.configuration.baseUrl, 'localhost:8088/wikis/shelton/dios')
  const entry = derived.config.plugins.find((one) => one.source === PLUGIN_SOURCE).options.registry.dios
  assert.equal(entry.published, 'http://localhost:8088/wikis/shelton/dios', 'the scheme the target carries, not an assumed https')
  assert.equal(entry.publishedIndex, './releases/localhost-8088-wikis/static/contentIndex.json')

  const served = await deriveSiteConfig(site, fakeQuartz(), {self: 'dios'}, {port: 8101, serving: true, target, die})
  assert.equal(served.config.configuration.baseUrl, 'localhost:8101', 'a dev server is still the localhost port')

  const legacy = await deriveSiteConfig(site, fakeQuartz(), {self: 'dios', baseUrl: 'wiki.example.org'}, {port: 8101, serving: false, die})
  const kept = legacy.config.plugins.find((one) => one.source === PLUGIN_SOURCE).options.registry.dios
  assert.equal(kept.published, 'https://wiki.example.org', 'a declared host with no target is what it was')
  assert.equal(kept.publishedIndex, './build/published/default/static/contentIndex.json')
})

test('a declared plugin is appended with a local source made absolute, or replaces one by source', async () => {
  const site = tmp()
  const project = tmp()
  const declaration = {
    plugins: [
      {source: './plugins/mine', options: {x: 1}, order: 70},
      {source: '@quartz-community/og-image', enabled: true},
      {source: {repo: '../elsewhere/plugin', name: 'other'}},
    ],
  }
  const {config} = await deriveSiteConfig(site, fakeQuartz(), declaration, {port: 8100, projectDir: project, die})

  const mine = config.plugins.find((one) => one.source === join(project, 'plugins/mine'))
  assert.ok(mine, 'a ./ source resolves against the project, not against Quartz')
  assert.deepEqual(mine.options, {x: 1})
  assert.equal(mine.order, 70)
  assert.equal(mine.enabled, true, 'appended entries are on unless declared otherwise')
  assert.equal(bySource(config, 'og-image').enabled, true, 'a project turns a toolbox default back on by source')
  const other = config.plugins.find((one) => one.source?.name === 'other')
  assert.equal(other.source.repo, join(project, '../elsewhere/plugin').replace(/\/$/, ''))
})

test('an unknown declaration key is one line, not a silent nothing', async () => {
  const site = tmp()
  const warned = []
  await deriveSiteConfig(site, fakeQuartz(), {titel: 'x'}, {port: 8100, die, warn: (m) => warned.push(m)})
  assert.equal(warned.length, 1)
  assert.match(warned[0], /site\.titel/)
})

test("a project's own quartz.config.yaml replaces the base and still gets the entry", async () => {
  const site = tmp()
  writeFileSync(join(site, 'quartz.config.yaml'), 'configuration:\n  pageTitle: Mine\nplugins:\n  - source: "@quartz-community/og-image"\n    enabled: true\n')
  const {config, own} = await deriveSiteConfig(site, fakeQuartz(), {title: 'ignored', self: 'me'}, {port: 8100, die})

  assert.equal(own, true)
  assert.equal(config.configuration.pageTitle, 'Mine', 'the declaration does not reach a file the project owns')
  assert.equal(bySource(config, 'og-image').enabled, true, "nor do the toolbox's changes")
  const entry = config.plugins.find((one) => one.source === PLUGIN_SOURCE)
  assert.equal(entry.options.self, 'me', 'but the plugin entry is still the declaration\'s')
})

test('a tracked file still wired the old way is refused, naming the migration', async () => {
  const site = tmp()
  writeFileSync(join(site, 'quartz.config.yaml'), 'plugins:\n  - source: "../awt-links"\n    enabled: true\n  - source: "../awt-headings"\n')
  await assert.rejects(
    () => deriveSiteConfig(site, fakeQuartz(), {}, {port: 8100, die}),
    (error) => {
      assert.match(error.message, /\.\.\/awt-links, \.\.\/awt-headings/)
      assert.match(error.message, /awt site migrate/)
      return true
    },
  )
})

test('writeSiteConfig lands the derived file in build/, which ignores itself, marked generated', async () => {
  const site = tmp()
  const {file, name} = await writeSiteConfig(site, fakeQuartz(), {title: 'T'}, {port: 8100, die})
  assert.equal(name, DERIVED_CONFIG)
  assert.equal(name, 'build/quartz.config.yaml')
  assert.equal(file, join(site, 'build', 'quartz.config.yaml'))
  assert.match(readFileSync(join(site, 'build', '.gitignore'), 'utf8'), /^\*$/m, 'the first write into build/ makes the file that ignores it')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^# GENERATED by awt/)
  assert.match(text, /pageTitle: T/)
  assert.match(text, /quartz.config.yaml beside this one/, 'it says how to take the file over')
})

// ------------------------------------------------------------------ migrate

test('extractDeclaration lifts exactly what four real configs were found to differ in', () => {
  const tracked = {
    configuration: {pageTitle: 'DIOS data wiki', baseUrl: 'localhost:8102'},
    plugins: [
      {
        source: '../awt-cross-wiki',
        enabled: true,
        order: 55,
        options: {
          self: 'shelton-dios-data',
          registry: {
            'shelton-dios': {dev: 'http://localhost:8101', buildIndex: '../../shelton-dios/site/public/static/contentIndex.json'},
            'shelton-dios-data': {dev: 'http://localhost:8102', buildIndex: './build/dev/static/contentIndex.json'},
          },
        },
      },
      {source: '../awt-folder-notes', enabled: true, options: {index: './build/awt-index.json'}},
      {source: '../awt-links', enabled: true, options: {index: './build/awt-index.json', failOnDisagreement: true}},
      {source: '@quartz-community/footer', options: {links: {Quartz: 'https://github.com/jackyzha0/quartz'}}},
      {source: '@quartz-community/explorer', enabled: true},
      {source: '@quartz-community/note-properties', options: {includedProperties: ['type', 'domain']}},
    ],
  }
  const {declaration, notes} = extractDeclaration(tracked)
  assert.deepEqual(declaration, {
    title: 'DIOS data wiki',
    self: 'shelton-dios-data',
    registry: {
      'shelton-dios': {dev: 'http://localhost:8101', buildIndex: '../../shelton-dios/site/public/static/contentIndex.json'},
    },
    properties: ['type', 'domain'],
    footer: {Quartz: 'https://github.com/jackyzha0/quartz'},
  })
  assert.equal(declaration.baseUrl, undefined, 'a localhost base URL is the port, not a host')
  assert.equal(notes.length, 1)
  assert.match(notes[0], /shelton-dios-data.*derived now/)

  const block = renderDeclaration(declaration)
  assert.match(block, /^  site: \{/)
  assert.match(block, /\},$/)
})

test('extractDeclaration carries a real host and says what has no equivalent', () => {
  const {declaration, notes} = extractDeclaration({
    configuration: {pageTitle: 'W', baseUrl: 'https://wiki.example.org'},
    plugins: [
      {source: '../awt-links', enabled: false, options: {failOnDisagreement: false}},
      {
        source: '@quartz-community/footer',
        options: {links: {GitHub: 'https://github.com/jackyzha0/quartz', 'Discord Community': 'https://discord.gg/cRFFHYye7t'}},
      },
    ],
  })
  assert.equal(declaration.baseUrl, 'wiki.example.org')
  assert.equal(declaration.footer, undefined, "Quartz's stock links are nobody's choice")
  assert.equal(notes.length, 3)
  assert.match(notes.join('\n'), /shadow was off/)
  assert.match(notes.join('\n'), /failOnDisagreement/)
})
