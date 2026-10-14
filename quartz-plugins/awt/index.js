/**
 * awt — the toolbox inside a Quartz build. One plugin, both a transformer and an
 * emitter, and everything it does comes from reading the toolbox's index as data.
 *
 * It replaced four plugins that read the same file the same way, and were wired
 * into every project separately: a change to any of them meant a change to every
 * wiki's config. Now the toolbox writes the one entry that names this package
 * into the config it derives for a build, and a project's own files say nothing
 * about it. Quartz allows the merge outright: `quartz.category` may be a list,
 * the loader puts the package into each matching bucket and calls the default
 * factory once per bucket, and checks only that the instance *has* the methods
 * that bucket needs. So two instances of this exist during a build, one asked
 * for `markdownPlugins`/`htmlPlugins` and one for `emit`, and each reads the
 * index for itself. That is cheap, and it is also the only correct shape: above
 * 128 files Quartz parses in a worker pool and hands each worker a structured
 * clone, so nothing shared between instances would survive anyway.
 *
 * THE INDEX IS READ, NEVER RECOMPUTED. Every fact below — a note's address, the
 * headings on a page, what a link resolves to — is decided in `core` and carried
 * in `build/awt-index.json`. Recomputing any of it here would be a second
 * implementation free to disagree, and the failure mode is a link that renders and
 * points somewhere wrong. `awt site serve` and `awt site publish` emit the index
 * immediately before the build; a build started any other way has to run
 * `awt site index` first. `awt site serve` also re-emits it after every edit, so
 * the file is re-read whenever it changes: Quartz keeps one plugin instance for
 * the life of a dev server, and an index read once would be the pre-edit one
 * for every rebuild after.
 *
 * A MISSING INDEX IS AN ERROR, ONE POLICY, EVERYWHERE. Four plugins had three
 * answers to that file being absent — refuse, warn, stay silent — and the reasoning
 * for the silent one held only while all four were enabled together, which two of
 * the four wikis on the machine this was written on were not. Comparing against a
 * stale index is the same error: it reports disagreements that are not real and
 * hides ones that are. The staleness check runs once, in the emitter, where the
 * whole tree is in view.
 *
 * UNDER `awt site serve`, STALE MEANS "WAIT", NOT "FAIL". A save reaches Quartz's
 * watcher and the one `awt site serve` re-emits the index from, and which of them
 * finishes first is not decided anywhere. So when the server was started with
 * `AWT_INDEX_FOLLOWS` set — which says an index is on its way — every read waits,
 * synchronously and for a bounded time, until the index is at least as new as the
 * notes; only then, if it still is not, does the emitter throw. Synchronously
 * because Quartz calls `markdownPlugins` synchronously, and the transformer needs
 * the new index to put a new folder note at its address. Blocking Quartz's thread
 * blocks nothing that writes the index: that is a different process.
 *
 * ZERO DEPENDENCIES. Quartz symlinks a local plugin directory into
 * `.quartz/plugins/` and imports it from there, so a bare specifier would have to
 * resolve from outside the Quartz tree. `fs` and `path` are the whole import list,
 * and the cross-wiki reference grammar is restated rather than imported from
 * `syntax`; `packages/publish/test/cross-wiki-agreement.test.js` holds the two
 * together.
 *
 * WHAT EACH HALF DOES
 *
 * Transformer, markdown pass:
 *   - Folder notes. A note beside a folder of its own name is that folder's
 *     landing page, at the address the index gives it. `file.data.slug` moves so
 *     emitters write the page there, FolderPage sees the folder already has a
 *     landing page, and the navigation trie carries the note's title with its
 *     address. `ctx.allSlugs` does NOT move: CrawlLinks matches link text against
 *     the last segment of each slug, and a moved entry's last segment is `index`.
 *   - Cross-wiki references. `[text](prefix:path.md#anchor)` becomes the URL the
 *     target wiki actually serves, read from that wiki's own `contentIndex.json`
 *     and never computed. Which registry address is used comes from the `target`
 *     option `awt` derives with the config (`ctx.argv.serve` for a hand-wired one):
 *     a dev server links to registry `dev` bases, a publish build to `published`
 *     ones. Everything unresolvable is a warning, never a failure, because a wiki
 *     has to build before the wikis it depends on have ever been built.
 *
 * Transformer, html pass:
 *   - The second half of folder notes. CrawlLinks resolves to the slug it matched,
 *     so a link to a moved note comes out one segment too shallow; a host trying
 *     `$uri/index.html` still finds the page and then serves it under a URL from
 *     which every relative asset resolves against the parent folder. The trailing
 *     slash goes back on the finished href, whatever link syntax produced it. This
 *     has to be an html pass: Quartz runs every transformer's markdown pass over
 *     every file before any html pass runs, so the slug is settled site-wide by
 *     the time the first href is read. It must run after CrawlLinks, which is
 *     what the order the toolbox writes (61, above crawl-links' 60) is for.
 *
 * Emitter:
 *   - `static/awtHeadings.json`: every published page's heading anchors, keyed by
 *     served address beside the file path, mirroring `contentIndex.json` so a
 *     consumer reads both the same way. It is what lets another wiki check a
 *     cross-wiki reference that carries an anchor.
 *   - The shadow (toolbox-decisions 10). Two resolvers currently compute where
 *     every link goes — Quartz's `crawl-links` at the hast layer, the toolbox's at
 *     the source layer — and this compares them page by page and fails the build
 *     when they disagree. The point is not that ours is right: it is that the
 *     incumbent validates the replacement across real edits and real Quartz bumps
 *     before anything is switched off. It is an emitter so the report covers the
 *     whole wiki rather than dying on the first page. `shadow: false` is the
 *     resolver switch, when its gate is met; the check goes and nothing else moves.
 */
import fs from 'fs'
import path from 'path'

const DEFAULTS = {
  index: './build/awt-index.json',
  // How long a read under `awt site serve` waits for the index to catch up.
  followTimeoutMs: 30000,
  self: null,
  registry: {},
  shadow: true,
  headings: 'static/awtHeadings.json',
  // The page listing every wiki on the host, for the button that leads back to it.
  home: null,
  warnOnUnknownPrefix: true,
  warnOnMissingIndex: true,
  warnOnMissingPath: true,
  warnOnMissingAnchor: true,
}

// ------------------------------------------------------------------ the index

/**
 * Where the site root is: found by following the symlink Quartz's working directory always
 * holds to the config Quartz is reading, which is in `<site>/build/` (or, from an older setup, in
 * `<site>/` itself). That needs no configured depth and cannot drift when the depth does — which it did once, when
 * Quartz moved from `site/.quartz-src` to `site/node_modules/quartz`.
 *
 * With no symlink there is no site root to find, and saying so is the useful
 * error: falling back to Quartz's own directory produced a "no index at
 * node_modules/quartz/.awt-index.json" that named a file nobody ever had.
 */
function siteRoot(cwd = process.cwd()) {
  const link = path.join(cwd, 'quartz.config.yaml')
  try {
    const dir = path.dirname(fs.realpathSync(link))
    // The derived config is in `<site>/build/`, so that directory's parent is the site; a config beside
    // `package.json`, as an older setup left it, is in the site itself.
    return path.basename(dir) === 'build' ? path.dirname(dir) : dir
  } catch {
    throw new Error(
      `awt: ${link} is not a link into the site directory, so the site root cannot be found.\n` +
        '  Build with `awt site serve` or `awt site publish`, which wire it, or run `awt site setup`.',
    )
  }
}

function indexPath(options) {
  return path.isAbsolute(options.index) ? options.index : path.resolve(siteRoot(), options.index)
}

/** The index, parsed, or a thrown error that says how to get one. */
function readArtifact(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    throw new Error(
      `awt: no index at ${file}, so nothing here can run.\n` +
        '  Build with `awt site serve` or `awt site publish`, which emit it first, or run\n' +
        `  \`awt site index\` immediately before the build.`,
    )
  }
}

/**
 * The newest mtime among the wiki's notes and the directories holding them, or
 * `null` when the tree cannot be read — an index emitted on another machine,
 * which is a reason to say so rather than to fail.
 *
 * Directories count because a deleted or renamed note leaves no file mtime
 * behind, and its old address in the index is as stale as an edited note's links.
 * `awt site serve` re-emits on the same set of changes (`packages/publish/lib/follow.js`).
 */
function newestNote(root) {
  let newest = null
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true})
      const {mtimeMs} = fs.statSync(dir)
      if (newest === null || mtimeMs > newest) newest = mtimeMs
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.toLowerCase().endsWith('.md')) {
        const {mtimeMs} = fs.statSync(full)
        if (newest === null || mtimeMs > newest) newest = mtimeMs
      }
    }
  }
  walk(root)
  return newest
}

/** Whether `awt site serve` started this build and is keeping the index current. */
const following = () => Boolean(process.env.AWT_INDEX_FOLLOWS)

/** A synchronous sleep, for the one caller that cannot await (see the header). */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The index, re-read whenever the file changes. Stat before read: a rename
 * between the two then leaves an mtime that is older than the data, which the
 * next call re-reads, rather than one that is newer and never re-read.
 */
function indexReader(options) {
  let cached = null
  const read = () => {
    const file = indexPath(options)
    let mtimeMs = null
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      // readArtifact says what is wrong.
    }
    if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached
    cached = {file, mtimeMs, data: readArtifact(file)}
    return cached
  }

  /**
   * `{file, mtimeMs, data, newest}`, where `newest` is the notes' newest mtime.
   * When following, waits for `mtimeMs >= newest` for up to `followTimeoutMs`
   * and then returns whatever it has; deciding that stale is fatal is the
   * emitter's call, not every reader's.
   */
  return () => {
    const deadline = Date.now() + options.followTimeoutMs
    for (;;) {
      const current = read()
      const newest = current.data.notesDir ? newestNote(current.data.notesDir) : null
      const stale = newest !== null && newest > current.mtimeMs
      if (!stale || !following() || Date.now() >= deadline) return {...current, newest}
      pause(50)
    }
  }
}

// ------------------------------------------------------------ folder notes

/** slug → address, for the notes whose address is not their slug. */
function movesIn(artifact) {
  const moves = new Map()
  for (const [slug, page] of Object.entries(artifact.pages ?? {})) {
    if (page?.address && page.address !== slug) moves.set(slug, page.address)
  }
  return moves
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Where an href lands, as a slug — or `null` if it is not this site's to resolve.
 *
 * `from` is the slug of the page the href was written on, which by this point is
 * the *moved* slug, and which is also what CrawlLinks measured its relative paths
 * against. Resolving against anything else would be off by the very segment this
 * plugin added.
 */
export function resolveHref(from, href) {
  if (!href || href.startsWith('#') || href.startsWith('//') || SCHEME.test(href)) return null
  const [link] = href.split('#')
  // Already a folder URL. Nothing to add, and adding it would be wrong.
  if (!link || link.endsWith('/')) return null
  const base = link.startsWith('/') ? '/' : path.posix.dirname(`/${from}`)
  return path.posix.normalize(path.posix.join(base, link)).replace(/^\/+/, '')
}

/** Every `<a href=…>` in a hast tree. No dependency on unist-util-visit. */
function visitAnchors(node, visitor) {
  if (!node || typeof node !== 'object') return
  if (node.tagName === 'a' && typeof node.properties?.href === 'string') visitor(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) visitAnchors(child, visitor)
  }
}

function classesOf(node) {
  const classes = node.properties?.className
  if (Array.isArray(classes)) return classes
  if (typeof classes === 'string') return classes.split(/\s+/)
  return []
}

// ---------------------------------------------------------- cross-wiki links

/**
 * `prefix:some/path.md#anchor`.
 *
 * This grammar is `packages/syntax/lib/cross-wiki.js`'s, restated rather than
 * imported. The two used to differ — a prefix carrying an uppercase letter, a `.`
 * or a `+` was a cross-wiki reference to the toolbox and an ordinary link to the
 * renderer — which is a link excluded from the graph and never resolved in the
 * site, reported by neither. Change one, change the other; the agreement test
 * fails when they part company.
 */
const REFERENCE = /^([A-Za-z][A-Za-z0-9+.-]*):(?!\/\/)(\S+)$/

/** Schemes that are never registry keys, whatever the registry says. */
const RESERVED = new Set([
  'about',
  'blob',
  'data',
  'file',
  'ftp',
  'http',
  'https',
  'javascript',
  'mailto',
  'sms',
  'tel',
  'urn',
])

/**
 * `{prefix, target, anchor}` for a cross-wiki destination, or `null`. `anchor`
 * keeps its `#`, because all anything here does is append it to a resolved URL.
 */
export function parseReference(url) {
  const match = REFERENCE.exec(url ?? '')
  if (!match) return null

  const [, prefix, rest] = match
  if (RESERVED.has(prefix.toLowerCase())) return null

  const hash = rest.indexOf('#')
  const target = hash === -1 ? rest : rest.slice(0, hash)
  if (!target) return null

  return {prefix, target, anchor: hash === -1 ? '' : rest.slice(hash)}
}

function slugifyFallback(filePath) {
  // Only reached when the target's index is unavailable. Deliberately crude:
  // it is a guess, and the warning beside it says so.
  return filePath.replace(/\.md$/, '').replace(/\/index$/, '')
}

function joinUrl(base, slug) {
  return `${base.replace(/\/+$/, '')}/${slug.replace(/^\/+/, '')}`
}

/**
 * The heading anchors a wiki built with this plugin publishes beside its
 * `contentIndex.json`, keyed by slug, so `prefix:path.md#anchor` can be checked
 * against a real heading.
 */
function readHeadings(contentIndex) {
  const file = path.join(path.dirname(contentIndex), 'awtHeadings.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const bySlug = new Map()
  for (const [slug, entry] of Object.entries(raw)) {
    if (Array.isArray(entry?.headings)) bySlug.set(slug, new Set(entry.headings))
  }
  return bySlug
}

/** contentIndex.json is keyed by slug; the lookup needs the reverse. */
function readContentIndex(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const byFilePath = new Map()
  for (const entry of Object.values(raw)) {
    if (entry && typeof entry.filePath === 'string' && typeof entry.slug === 'string') {
      byFilePath.set(entry.filePath, entry.slug)
    }
  }
  return byFilePath
}

/** filePath → slug for the wiki being built, from ctx. */
function selfIndex(ctx) {
  const files = ctx.allFiles ?? []
  const slugs = ctx.allSlugs ?? []
  const map = new Map()
  if (files.length !== slugs.length) return map
  for (let i = 0; i < files.length; i++) map.set(files[i], slugs[i])
  return map
}

function walkLinks(node, visit) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'link') visit(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkLinks(child, visit)
  }
}

/**
 * Which registry address cross-wiki links are written against: `dev` or `published`.
 *
 * `awt` writes the answer into the plugin's options (`target`) when it derives the
 * config, so the choice belongs to the command that asked for the build and not to a
 * flag that happens to be on Quartz's command line. A config with no `target` is a
 * hand-wired one, and keeps what it always did: `--serve` means dev.
 *
 * The two are checked against each other when both are there. A derived config left
 * over from a dev server and then built by hand without `--serve` would otherwise
 * produce a release full of localhost links that every page serves and every link
 * answers 200 to, which is the failure the old coupling existed to prevent.
 */
function linkTarget(ctx, options) {
  const fromFlag = ctx?.argv?.serve ? 'dev' : 'published'
  if (options.target === undefined) return fromFlag
  if (options.target !== 'dev' && options.target !== 'published') {
    throw new Error(`awt: plugin option target is "${options.target}", expected "dev" or "published"`)
  }
  if (ctx?.argv && options.target !== fromFlag) {
    throw new Error(
      `awt: the derived config is for a ${options.target} build, but this build ${ctx.argv.serve ? 'has' : 'lacks'} --serve. ` +
        'Run it through `awt site serve` or `awt site publish`, which derive the config for the build they start.',
    )
  }
  return options.target
}

/** The cross-wiki rewriter over one build, with its per-build caches. */
function crossWikiPass(ctx, options) {
  const serving = linkTarget(ctx, options) === 'dev'

  // `null` means "already tried and failed" — a missing index warns once, not
  // once per reference.
  const indexes = new Map()
  const headings = new Map()
  const warnedPrefixes = new Set()
  let self = null

  // Relative to the site root, like the config file the registry used to sit in.
  // Resolved lazily: an absolute path needs no site root, and a test has none.
  const contentIndexOf = (entry) => {
    const rel = serving ? entry.buildIndex : entry.publishedIndex
    if (!rel) return null
    return path.isAbsolute(rel) ? rel : path.resolve(siteRoot(), rel)
  }

  const targetIndex = (prefix, entry) => {
    if (indexes.has(prefix)) return indexes.get(prefix)
    const abs = contentIndexOf(entry)
    let loaded = null
    if (!abs) {
      if (options.warnOnMissingIndex) {
        console.warn(
          `⚠ awt: no ${serving ? 'buildIndex' : 'publishedIndex'} configured for "${prefix}"; slugs will be guessed`,
        )
      }
    } else {
      try {
        loaded = readContentIndex(abs)
      } catch {
        if (options.warnOnMissingIndex) {
          console.warn(
            `⚠ awt: cannot read ${prefix}'s content index at ${abs}; slugs will be guessed. Build that wiki to fix this.`,
          )
        }
      }
    }
    indexes.set(prefix, loaded)
    return loaded
  }

  /**
   * The target wiki's published heading anchors, or `null` when it publishes
   * none. Silence is the right answer there: a wiki built without this plugin
   * has not said its anchors are unknown, it has said nothing, and warning about
   * every anchor into it would drown the ones that mean something.
   */
  const targetHeadings = (prefix, entry) => {
    if (headings.has(prefix)) return headings.get(prefix)
    const abs = contentIndexOf(entry)
    let loaded = null
    if (abs) {
      try {
        loaded = readHeadings(abs)
      } catch {
        loaded = null
      }
    }
    headings.set(prefix, loaded)
    return loaded
  }

  return (tree, file) => {
    const where = file?.data?.filePath ?? file?.path ?? '?'

    walkLinks(tree, (node) => {
      const reference = parseReference(node.url)
      if (!reference) return

      const {prefix, target, anchor} = reference
      const entry = options.registry[prefix]
      if (!entry) {
        if (options.warnOnUnknownPrefix && !warnedPrefixes.has(prefix)) {
          warnedPrefixes.add(prefix)
          console.warn(`⚠ awt: unknown wiki prefix "${prefix}" (first seen in ${where}); left as written`)
        }
        return
      }

      // A reference naming the wiki being built becomes an ordinary internal
      // link, so it keeps hover previews and backlinks instead of bouncing the
      // reader out to their own site.
      if (prefix === options.self) {
        self ??= selfIndex(ctx)
        const slug = self.get(target) ?? slugifyFallback(target)
        node.url = `/${slug}${anchor}`
        return
      }

      const baseUrl = serving ? entry.dev : entry.published
      if (!baseUrl) {
        if (options.warnOnUnknownPrefix) {
          console.warn(
            `⚠ awt: "${prefix}" has no ${serving ? 'dev' : 'published'} base URL; left as written (${where})`,
          )
        }
        return
      }

      const index = targetIndex(prefix, entry)
      let slug = index?.get(target)
      if (slug === undefined) {
        if (index && options.warnOnMissingPath) {
          console.warn(`⚠ awt: ${prefix}:${target} is not a page ${prefix} serves (referenced in ${where})`)
        }
        slug = slugifyFallback(target)
      } else if (anchor && options.warnOnMissingAnchor) {
        // A warning and never a failure: the target wiki may not have been
        // rebuilt since the heading was written.
        const anchors = targetHeadings(prefix, entry)?.get(slug)
        if (anchors && !anchors.has(anchor.slice(1))) {
          console.warn(
            `⚠ awt: ${prefix}:${target} has no heading "${anchor}" (referenced in ${where}); ` +
              'the link lands on the page, not the place',
          )
        }
      }

      node.url = joinUrl(baseUrl, slug) + anchor
    })
  }
}

// ----------------------------------------------------------------- the shadow

function eachElement(node, visitor) {
  if (node.type === 'element') visitor(node)
  for (const child of node.children ?? []) eachElement(child, visitor)
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort()
}

/**
 * Whether the note behind `page` changed after Quartz read it, so the page
 * Quartz rendered is not the note the index describes.
 *
 * Under `awt site serve` the index follows every save, and Quartz's content does
 * not always: a save during a rebuild is re-read by the next one, and a save
 * during the *first* build is not re-read at all, because Quartz's watcher starts
 * after it. Comparing such a page would fail the build over a disagreement that
 * is only timing — and a failed first build ends the server. `awtReadAt` is set
 * by the markdown pass below, which runs on the file just after Quartz reads it.
 */
function changedSinceRead(artifact, page, vfile) {
  const readAt = vfile.data?.awtReadAt
  if (typeof readAt !== 'number' || !artifact.notesDir || !page.path) return false
  try {
    return fs.statSync(path.join(artifact.notesDir, page.path)).mtimeMs > readAt
  } catch {
    // Gone since: the index already says so, and Quartz has the old page.
    return true
  }
}

/**
 * Compare what Quartz rendered against what the index says, page by page.
 * Returns the report lines, empty when the resolvers agree, and the pages set
 * aside because their note changed after Quartz read it.
 */
function shadowReport(artifact, content) {
  // Keyed by the address a page is *served* at, which is not always its slug:
  // the folder-note move above changes `vfile.data.slug` before an emitter sees
  // it, and looking pages up by slug alone dropped every moved note out of the
  // comparison — silently, and without counting it.
  const byAddress = new Map()
  for (const [slug, page] of Object.entries(artifact.pages ?? {})) {
    byAddress.set(page.address ?? slug, page)
  }

  const disagreements = []
  const unsettled = []
  let compared = 0

  for (const [tree, vfile] of content) {
    const slug = vfile.data?.slug
    const page = byAddress.get(slug)
    // Tag pages, folder pages and the 404 are Quartz's own, not notes.
    if (!page) continue
    if (changedSinceRead(artifact, page, vfile)) {
      unsettled.push(slug)
      continue
    }
    compared++

    const rendered = new Set()
    const renderedBroken = new Set()
    eachElement(tree, (node) => {
      if (node.tagName !== 'a') return
      const destination = node.properties?.['data-slug']
      if (typeof destination !== 'string') return // external, or an in-page anchor
      if (classesOf(node).includes('broken')) renderedBroken.add(destination)
      else rendered.add(destination)
    })

    const ours = new Set(page.links)
    const oursBroken = new Set(page.unresolved)

    // An ambiguous link is where the two resolvers differ by design, so whatever
    // Quartz did with it is not drift. awt reports two matches as an error at
    // edit time; Quartz resolves only on a unique match and otherwise falls
    // through *silently* to a root-relative slug — usually a 404, occasionally a
    // real page. The shadow cannot predict which, so it excludes the landing slug
    // from the comparison in both directions. `awt check` is what reports these.
    const undecided = new Set(page.ambiguousSlugs ?? [])
    const without = (slugs) => slugs.filter((value) => !undecided.has(value))

    const row = {
      slug,
      missing: difference(ours, rendered),
      extra: without(difference(rendered, ours)),
      brokenMissing: difference(oursBroken, renderedBroken),
      brokenExtra: without(difference(renderedBroken, oursBroken)),
    }
    if (row.missing.length || row.extra.length || row.brokenMissing.length || row.brokenExtra.length) {
      disagreements.push(row)
    }
  }

  return {compared, disagreements, unsettled: unsettled.sort()}
}

function formatDisagreements(rows) {
  return rows
    .map((row) => {
      const parts = []
      if (row.missing.length) parts.push(`    ours resolves, quartz does not: ${row.missing.join(', ')}`)
      if (row.extra.length) parts.push(`    quartz resolves, ours does not: ${row.extra.join(', ')}`)
      if (row.brokenMissing.length) parts.push(`    ours calls unresolved: ${row.brokenMissing.join(', ')}`)
      if (row.brokenExtra.length) parts.push(`    quartz calls broken: ${row.brokenExtra.join(', ')}`)
      return `  ${row.slug}\n${parts.join('\n')}`
    })
    .join('\n')
}

// ----------------------------------------------------------------- the plugin

/**
 * The look the toolbox gives every wiki it publishes, on top of Quartz's own styles.
 * Quartz builds its grid from a compile-time SCSS variable inside the shared install,
 * which no project may edit, so the overrides ride in as a plugin resource instead.
 *
 *   - The left column (the Explorer) is 420px, not 320.
 *   - Every entry in an Explorer folder gets a short branch off the folder's vertical
 *     line, so a title that wraps still reads as one entry, and wrapped lines hang
 *     under the first rather than under the branch.
 *   - A button at the top right hides both sidebars and lets the page use the whole
 *     window, for tables. Prose stays at a readable measure; tables, code, diagrams
 *     and images take the room. The choice is remembered per browser.
 */
const SITE_CSS = `
@media (min-width: 801px) {
  #quartz-body { grid-template-columns: 420px auto !important; }
}
@media (min-width: 1201px) {
  #quartz-body { grid-template-columns: 420px auto 320px !important; }
}
.explorer-content .folder-outer > ul { border-left-color: var(--gray); }
.explorer-content .folder-outer > ul > li { position: relative; padding: 0.12rem 0; }
.explorer-content .folder-outer > ul > li::before {
  content: "";
  position: absolute;
  left: -0.8rem;
  top: 0.95em;
  width: 0.65rem;
  border-top: 1px solid var(--gray);
}
.explorer-content .folder-outer > ul > li > a { display: block; line-height: 1.3; }

#awt-wide-toggle {
  position: fixed; top: 0.6rem; right: 0.8rem; z-index: 200;
  width: 2rem; height: 2rem; padding: 0; cursor: pointer;
  font: inherit; font-size: 1.1rem; line-height: 1;
  color: var(--darkgray); background: var(--light);
  border: 1px solid var(--lightgray); border-radius: 6px;
}
#awt-wide-toggle:hover { border-color: var(--gray); color: var(--dark); }
@media (max-width: 800px) { #awt-wide-toggle { display: none; } }
@media (min-width: 801px) {
  html.awt-wide .page { max-width: none; }
  html.awt-wide #quartz-body {
    grid-template-columns: minmax(0, 1fr) !important;
    grid-template-areas: "grid-header" "grid-center" "grid-footer" !important;
  }
  html.awt-wide #quartz-body > .sidebar { display: none; }
  html.awt-wide #quartz-body .center { box-sizing: border-box; padding: 0 2rem; }
  html.awt-wide article .markdown-preview-view > :is(p, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, dl, hr) { max-width: 75ch; margin-left: auto; margin-right: auto; }
}

#awt-home {
  position: fixed; top: 0.6rem; right: 3.2rem; z-index: 200;
  box-sizing: border-box; width: 2rem; height: 2rem;
  display: flex; align-items: center; justify-content: center;
  font-size: 1.1rem; line-height: 1; text-decoration: none;
  color: var(--darkgray); background: var(--light);
  border: 1px solid var(--lightgray); border-radius: 6px;
}
#awt-home:hover { border-color: var(--gray); color: var(--dark); }
@media (max-width: 800px) { #awt-home { right: 0.8rem; } }

a.awt-zoom { cursor: zoom-in; }
#awt-zoom-overlay {
  position: fixed; inset: 0; z-index: 1000; overflow: auto;
  display: flex; background: color-mix(in srgb, var(--light) 92%, transparent);
  cursor: zoom-out;
}
#awt-zoom-overlay img {
  margin: auto; max-width: 96vw; max-height: 96vh; object-fit: contain;
  background: white; box-shadow: 0 0 1.5rem rgb(0 0 0 / 0.25); cursor: zoom-in;
}
#awt-zoom-overlay.awt-actual img { max-width: none; max-height: none; cursor: zoom-out; }
`

/**
 * A picture in a note opens at full size. The link is in the HTML, so a build with no
 * scripts (the offline handoff) still opens the image itself; where scripts run, the
 * link opens an overlay instead. The overlay fits the image to the window, a click on
 * the image shows it at its own size to scroll around in, and Escape or a click beside
 * it closes it.
 */
const ZOOM_JS = `
(() => {
  if (window.awtZoom) return
  window.awtZoom = true
  const close = () => document.getElementById('awt-zoom-overlay')?.remove()
  const open = (href, alt) => {
    close()
    const overlay = document.createElement('div')
    overlay.id = 'awt-zoom-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', alt || 'Image')
    const img = document.createElement('img')
    img.src = href
    img.alt = alt
    overlay.appendChild(img)
    overlay.addEventListener('click', (event) => {
      if (event.target === img) overlay.classList.toggle('awt-actual')
      else close()
    })
    document.body.appendChild(overlay)
  }
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = event.target.closest?.('a.awt-zoom')
    if (!link) return
    event.preventDefault()
    open(link.href, link.querySelector('img')?.alt ?? '')
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })
  document.addEventListener('nav', close)
})()
`

/**
 * A button beside the sidebar toggle that leads back to the page listing every wiki on
 * the host this one is served from. The address is the build's to give, so a wiki
 * served on its own, or built for nowhere, gets no button.
 */
const homeJs = (home) => `
(() => {
  const ensure = () => {
    if (document.getElementById('awt-home')) return
    const link = document.createElement('a')
    link.id = 'awt-home'
    link.href = ${JSON.stringify(home)}
    link.textContent = '\\u2302'
    link.title = 'All wikis'
    link.setAttribute('aria-label', 'All wikis')
    link.dataset.routerIgnore = ''
    document.body.appendChild(link)
  }
  document.addEventListener('nav', ensure)
  ensure()
})()
`

/**
 * Wrap every image in the note body that is not already a link in a link to the image
 * itself, marked for the overlay. `data-router-ignore` keeps Quartz's page router from
 * fetching a PNG as if it were a page.
 */
export function linkImages(node) {
  if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return
  if (node.tagName === 'a') return
  node.children = node.children.map((child) => {
    if (child?.tagName !== 'img' || typeof child.properties?.src !== 'string') {
      linkImages(child)
      return child
    }
    return {
      type: 'element',
      tagName: 'a',
      properties: {href: child.properties.src, className: ['awt-zoom'], dataRouterIgnore: ''},
      children: [child],
    }
  })
}

const SITE_JS = `
(() => {
  const KEY = 'awt-wide'
  const read = () => { try { return localStorage.getItem(KEY) === '1' } catch { return false } }
  const write = (on) => { try { localStorage.setItem(KEY, on ? '1' : '0') } catch {} }
  const apply = (on) => {
    document.documentElement.classList.toggle('awt-wide', on)
    const button = document.getElementById('awt-wide-toggle')
    if (button) button.setAttribute('aria-pressed', String(on))
  }
  // Page navigation swaps the document's contents, so the button and the class are
  // put back after every one; the stored choice is what survives.
  const ensure = () => {
    if (!document.getElementById('awt-wide-toggle')) {
      const button = document.createElement('button')
      button.id = 'awt-wide-toggle'
      button.type = 'button'
      button.textContent = '\u2194'
      button.title = 'Show or hide the sidebars'
      button.setAttribute('aria-label', 'Show or hide the sidebars')
      button.addEventListener('click', () => {
        const on = !document.documentElement.classList.contains('awt-wide')
        write(on)
        apply(on)
      })
      document.body.appendChild(button)
    }
    apply(read())
  }
  document.addEventListener('nav', ensure)
  ensure()
})()
`

export const Awt = (userOptions) => {
  const options = {...DEFAULTS, ...userOptions}

  // Read per instance, and again whenever the file changes. Two instances exist
  // per build (one per category bucket) and one per worker thread besides; each
  // reads for itself.
  const current = indexReader(options)
  const index = () => current().data

  return {
    name: 'Awt',

    externalResources() {
      return {
        css: [{content: SITE_CSS, inline: true}],
        js: [
          {loadTime: 'afterDOMReady', contentType: 'inline', script: SITE_JS},
          {loadTime: 'afterDOMReady', contentType: 'inline', script: ZOOM_JS},
          ...(options.home ? [{loadTime: 'afterDOMReady', contentType: 'inline', script: homeJs(options.home)}] : []),
        ],
      }
    },

    markdownPlugins(ctx) {
      const moved = movesIn(index())
      const crossWiki = crossWikiPass(ctx, options)
      return [
        () => (tree, file) => {
          if (file?.data) file.data.awtReadAt = Date.now()
          const address = moved.get(file?.data?.slug)
          if (address) file.data.slug = address
          crossWiki(tree, file)
        },
      ]
    },

    htmlPlugins() {
      const moved = movesIn(index())
      const zoom = () => (tree) => linkImages(tree)
      if (moved.size === 0) return [zoom]
      return [
        () => (tree, file) => {
          const from = file?.data?.slug
          if (!from) return
          visitAnchors(tree, (node) => {
            const landed = resolveHref(from, String(node.properties.href))
            if (landed === null || !moved.has(landed)) return
            // A link CrawlLinks could not resolve is a placeholder, and a
            // placeholder is the backlog signal rather than a URL to repair.
            if (classesOf(node).includes('broken')) return
            const [link, anchor = ''] = String(node.properties.href).split(/(#.*)$/)
            node.properties.href = `${link}/${anchor}`
          })
        },
        zoom,
      ]
    },

    async emit(ctx, content) {
      const {file, data, mtimeMs, newest} = current()

      // Stale is as wrong as missing, and this is the one place the whole tree is
      // in view to say so.
      if (newest === null) {
        console.warn(`⚠ awt: cannot read ${data.notesDir} to tell whether ${file} is current; continuing anyway.`)
      } else if (newest > mtimeMs) {
        throw new Error(
          following()
            ? `awt: ${file} did not catch up with the notes in ${data.notesDir} ` +
                `within ${options.followTimeoutMs / 1000}s.\n` +
                '  `awt site serve` re-emits it after every edit; its output above says why this one did not land.'
            : `awt: ${file} is older than the newest note in ${data.notesDir}.\n` +
                '  A stale index moves pages to old addresses and reports disagreements that are not real.\n' +
                '  Build with `awt site serve` or `awt site publish`, which emit it first.',
        )
      }

      const emitted = []

      // Only pages that actually got built: a note excluded from publishing has
      // no anchors anyone can link to. Keyed by served address, so a moved note
      // is found, and so the key means what contentIndex.json's key means.
      if (options.headings) {
        const published = new Set(content.map(([, vfile]) => vfile.data?.slug).filter(Boolean))
        const headings = {}
        for (const [slug, page] of Object.entries(data.pages ?? {})) {
          const address = page.address ?? slug
          if (!published.has(address)) continue
          headings[address] = {filePath: page.path, headings: page.headings ?? []}
        }
        const out = path.join(ctx.argv.output, options.headings)
        fs.mkdirSync(path.dirname(out), {recursive: true})
        fs.writeFileSync(out, JSON.stringify(headings))
        console.log(`✓ awt: ${Object.keys(headings).length} pages' headings in ${options.headings}`)
        emitted.push(out)
      }

      if (options.shadow) {
        const {compared, disagreements, unsettled} = shadowReport(data, content)
        if (unsettled.length) {
          console.warn(
            `⚠ awt: not compared, changed after Quartz read them: ${unsettled.join(', ')}\n` +
              "  A rebuild re-reads them; changes made during a dev server's first build are not seen\n" +
              '  until the note is saved again.',
          )
        }
        if (disagreements.length) {
          throw new Error(
            `awt: the two resolvers disagree on ${disagreements.length} of ${compared} pages\n` +
              formatDisagreements(disagreements),
          )
        }
        console.log(`✓ awt: both resolvers agree on all ${compared} pages`)
      }

      return emitted
    },
  }
}

export default Awt
