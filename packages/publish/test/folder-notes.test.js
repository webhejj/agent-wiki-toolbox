/**
 * awt-folder-notes, and the hole it would punch if it computed the rule itself.
 *
 * The plugin moves the slug Quartz reports for a page. Both `awt-links` and
 * `awt-headings` look a page up by that slug, so the three have to agree on what a
 * moved note is called — which is why the address is decided in `core`, published
 * in the index, and read here.
 */
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

const load = async () => (await import(new URL('../../../quartz-plugins/awt/index.js', import.meta.url).pathname)).default

/** An index carrying one moved note and one that stays put. */
function index(t) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-folder-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const file = join(dir, '.awt-index.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      notesDir: dir,
      slugs: ['campaigns/cosites-v2', 'campaigns/cosites-v2/design/one', 'notes/plain'],
      pages: {
        'campaigns/cosites-v2': {
          path: 'campaigns/cosites-v2.md',
          address: 'campaigns/cosites-v2/index',
          links: [],
          unresolved: [],
          ambiguous: [],
          headings: ['cosites-v2'],
        },
        'campaigns/cosites-v2/design/one': {
          path: 'campaigns/cosites-v2/design/one.md',
          address: 'campaigns/cosites-v2/design/one',
          links: [],
          unresolved: [],
          ambiguous: [],
          headings: [],
        },
        'notes/plain': {
          path: 'notes/plain.md',
          address: 'notes/plain',
          links: [],
          unresolved: [],
          ambiguous: [],
          headings: [],
        },
      },
    }),
  )
  return file
}

test('the moved note takes its folder\'s address, and nothing else moves', async (t) => {
  const plugin = (await load())({index: index(t)})
  const [transform] = plugin.markdownPlugins({})

  const moved = {data: {slug: 'campaigns/cosites-v2'}}
  const stayed = {data: {slug: 'notes/plain'}}
  transform()({type: 'root', children: []}, moved)
  transform()({type: 'root', children: []}, stayed)

  assert.equal(moved.data.slug, 'campaigns/cosites-v2/index')
  assert.equal(stayed.data.slug, 'notes/plain')
})

test('an href into a moved note gets the trailing slash back', async (t) => {
  const plugin = (await load())({index: index(t)})
  const [transform] = plugin.htmlPlugins({})

  const anchor = (href, className) => ({
    type: 'element',
    tagName: 'a',
    properties: {href, ...(className ? {className} : {})},
    children: [],
  })
  // Written on the child page, which is where CrawlLinks measured its relative
  // paths from — one segment too shallow without this pass.
  const toMoved = anchor('../../cosites-v2')
  const withAnchor = anchor('../../cosites-v2#a-heading')
  const broken = anchor('../../cosites-v2', ['internal', 'broken'])
  const elsewhere = anchor('../../../notes/plain')
  const external = anchor('https://example.com/campaigns/cosites-v2')

  transform()(
    {type: 'root', children: [toMoved, withAnchor, broken, elsewhere, external]},
    {data: {slug: 'campaigns/cosites-v2/design/one'}},
  )

  assert.equal(toMoved.properties.href, '../../cosites-v2/')
  assert.equal(withAnchor.properties.href, '../../cosites-v2/#a-heading')
  // A link the renderer could not resolve is the backlog signal, not a URL to repair.
  assert.equal(broken.properties.href, '../../cosites-v2')
  assert.equal(elsewhere.properties.href, '../../../notes/plain')
  assert.equal(external.properties.href, 'https://example.com/campaigns/cosites-v2')
})

test('an image in a note becomes a link to itself, marked for the overlay and kept from the page router', async (t) => {
  const plugin = (await load())({index: index(t)})
  const zoom = plugin.htmlPlugins({}).at(-1)
  const img = (src) => ({type: 'element', tagName: 'img', properties: {src, alt: 'a view'}, children: []})
  const loose = img('../views/01-context.png')
  const linked = img('../views/02-app.png')
  const tree = {
    type: 'root',
    children: [
      {type: 'element', tagName: 'p', properties: {}, children: [loose]},
      {type: 'element', tagName: 'a', properties: {href: 'elsewhere'}, children: [linked]},
    ],
  }
  zoom()(tree, {data: {slug: 'notes/plain'}})

  const wrapper = tree.children[0].children[0]
  assert.equal(wrapper.tagName, 'a')
  assert.equal(wrapper.properties.href, '../views/01-context.png')
  assert.deepEqual(wrapper.properties.className, ['awt-zoom'])
  assert.equal(wrapper.properties.dataRouterIgnore, '', 'Quartz would fetch the PNG as a page')
  assert.equal(wrapper.children[0], loose)
  // An image that is already a link keeps the link it was given.
  assert.equal(tree.children[1].properties.href, 'elsewhere')
  assert.equal(tree.children[1].children[0], linked)
})

test('the button back to every wiki ships only when the build names that page', async (t) => {
  const make = await load()
  const scripts = (options) => make({index: index(t), ...options}).externalResources().js.map((one) => one.script).join('\n')
  assert.match(scripts({home: 'http://localhost:8088/wikis/'}), /awt-home[\s\S]*"http:\/\/localhost:8088\/wikis\/"/)
  assert.doesNotMatch(scripts({}), /awt-home/)
})

test('with no index it refuses rather than guessing', async () => {
  const plugin = (await load())({index: '/nowhere/at/all.json'})
  assert.throws(() => plugin.markdownPlugins({}), /no index at \/nowhere\/at\/all.json/)
  assert.throws(() => plugin.htmlPlugins({}), /no index at/)
})

/**
 * The hole this design exists to avoid: the emitters see the *moved* slug, so
 * looking a page up by its index key would drop every moved note without saying so.
 */
test('the shadow and the heading list still find a moved note', async (t) => {
  const file = index(t)
  const page = (slug) => [{type: 'root', children: []}, {data: {slug}}]
  const content = [page('campaigns/cosites-v2/index'), page('notes/plain')]

  const plugin = (await load())({index: file})
  // Agreement on both pages — including the moved one, which used to be skipped
  // and was not even counted as skipped.
  const logged = []
  const real = console.log
  console.log = (message) => logged.push(message)
  t.after(() => {
    console.log = real
  })
  const out = mkdtempSync(join(tmpdir(), 'awt-folder-out-'))
  t.after(() => rmSync(out, {recursive: true, force: true}))
  const [written] = await plugin.emit({argv: {output: out}}, content)
  assert.match(logged.join('\n'), /agree on all 2 pages/)

  const published = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(written, 'utf-8')))
  // Keyed by address, which is also how Quartz keys contentIndex.json — so the
  // cross-wiki resolver can read one with a key it got from the other.
  assert.deepEqual(Object.keys(published).sort(), ['campaigns/cosites-v2/index', 'notes/plain'])
  assert.deepEqual(published['campaigns/cosites-v2/index'].headings, ['cosites-v2'])
})
