/**
 * The machine layer: the libraries this machine publishes to, kept in `~/.config/awt/`.
 *
 *     awt.yaml               default-library: the library used when none is named
 *     libraries/<name>.yaml  one library: its base, its collections in heading order, and each
 *                            collection's wikis
 *
 * A library is a base and the collections served under it; a collection is a path, a title, access
 * rules and a set of wikis; a wiki is served at `<base>/<collection path>/<name>/`. The design is in
 * the toolbox wiki's `awt-libraries` note.
 *
 *     base: http://localhost:8088/wikis
 *     title: Wikis on maci
 *     deploy:
 *       to: ~/.local/share/awt/libraries/local/    # library/ is the tree, conf.d/ the nginx config
 *     collections:
 *       shelton:
 *         path: clients/shelton
 *         title: Shelton
 *         wikis:
 *           shelton-dios:                          # the link key other wikis write
 *             name: dios                           # its URL segment, when not the key
 *             site: ~/Dev/Projects/Shelton/…/wiki/site
 *             repo: git@github.com:sheltonhu/shelton-dios.git
 *             path: wiki
 *
 * YAML because it takes comments, and `register` rewrites its own entry in a file a person may have
 * annotated: the `yaml` package edits a document without losing them. Block style throughout, which
 * `register` keeps.
 *
 * A COLLISION IS AN ERROR. A key in two collections of one library, two collections at one path or
 * one inside another, two wikis at one address, and one key with two checkouts across libraries all
 * stop the load and name both places. Across libraries the same key is normal: it is the same wiki.
 */
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Document, isMap, parseDocument } from "yaml"

import { DEV, PUBLISHED } from "./layout.js"
import { builtAt, newestNote } from "./stale.js"
import { MOUNT, resolveTarget, SEGMENT } from "./target.js"

export const KEY = /^[a-z][a-z0-9+.-]*$/
const LIBRARY_NAME = /^[a-z0-9][a-z0-9._-]*$/
const MACHINE_FIELDS = ["default-library"]
const LIBRARY_FIELDS = ["base", "title", "access", "trusted-proxies", "deploy", "cache", "collections"]
const COLLECTION_FIELDS = ["path", "title", "access", "wikis"]
const MEMBER_FIELDS = ["name", "site", "dev", "repo", "path"]
const ACCESS_FIELDS = ["allow", "basic"]

/** The directory: `$AWT_CONFIG_DIR`, else `awt` in the user's config directory. */
export function configDir(env = process.env, platform = process.platform) {
  if (env.AWT_CONFIG_DIR) return path.resolve(env.AWT_CONFIG_DIR)
  const base =
    platform === "win32"
      ? env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "awt")
}

export const expandHome = (p, home = os.homedir()) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p)
export const tildeHome = (p, home = os.homedir()) => (p === home ? "~" : p.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, p).split(path.sep).join("/")}` : p)

const throwing = (message) => {
  throw new Error(message)
}

const machineFile = (dir) => path.join(dir, "awt.yaml")
export const librariesDir = (dir) => path.join(dir, "libraries")
export const libraryFile = (dir, name) => path.join(librariesDir(dir), `${name}.yaml`)

/** The machine layer if there is a config directory with libraries in it, else null: a machine with none is not an error. */
export function loadMachineIfPresent({ dir = configDir(), die = throwing } = {}) {
  return fs.existsSync(machineFile(dir)) || fs.existsSync(librariesDir(dir)) ? loadMachine({ dir, die }) : null
}

/** The library named in `awt.yaml`, without loading anything else. */
export function readDefaultTarget(dir = configDir()) {
  const file = machineFile(dir)
  if (!fs.existsSync(file)) return null
  const value = parseDocument(fs.readFileSync(file, "utf8")).toJS()
  const name = value?.["default-library"]
  return typeof name === "string" && name.trim() ? name.trim() : null
}

// ---------------------------------------------------------------------------- reading

/** A file's YAML as a plain map, `null` when it is not there. Every problem names the file and line. */
function readMap(file, die) {
  if (!fs.existsSync(file)) return null
  const doc = parseDocument(fs.readFileSync(file, "utf8"))
  if (doc.errors.length) {
    const e = doc.errors[0]
    const line = e.linePos?.[0]?.line
    die(`${file}${line ? `:${line}` : ""}: ${e.code === "DUPLICATE_KEY" ? "a key appears twice: " : ""}${e.message.split("\n")[0]}`)
  }
  const value = doc.toJS()
  if (value === null || value === undefined) return {}
  if (typeof value !== "object" || Array.isArray(value)) die(`${file}: expected a map, found ${Array.isArray(value) ? "a list" : typeof value}.`)
  return value
}

const isMapValue = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/** Unknown fields are refused: a typo is otherwise a silent no-op. */
function onlyFields(value, fields, where, die) {
  if (!isMapValue(value)) die(`${where} is not a map of fields.`)
  for (const field of Object.keys(value)) if (!fields.includes(field)) die(`${where} has a field "${field}"; the fields are ${fields.join(", ")}.`)
}

const httpUrl = (value, where, die) => {
  if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value)) die(`${where} is not an http or https address: ${JSON.stringify(value)}`)
  return value.replace(/\/+$/, "")
}

/** A CIDR or a bare address, as nginx's `allow` and `set_real_ip_from` take them. */
function cidrs(value, where, die) {
  if (!Array.isArray(value)) die(`${where} is not a list of addresses.`)
  return value.map((item) => {
    const [address, bits, extra] = String(item).split("/")
    const family = net.isIP(address)
    const max = family === 4 ? 32 : 128
    if (!family || extra !== undefined || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= max))) die(`${where}: "${item}" is not an address or a CIDR range.`)
    return String(item)
  })
}

function checkAccess(value, where, die) {
  onlyFields(value, ACCESS_FIELDS, where, die)
  const out = {}
  if (value.allow !== undefined) out.allow = cidrs(value.allow, `${where} allow`, die)
  if (value.basic !== undefined) {
    if (typeof value.basic !== "string" || !SEGMENT.test(value.basic)) die(`${where} basic "${value.basic}" is not the name of an htpasswd file.`)
    out.basic = value.basic
  }
  return out
}

/** A deploy destination: a local directory, or `host:path` for rsync over ssh. */
export function parseDestination(to) {
  const remote = /^([^/:\s]+):(.+)$/.exec(to)
  return remote ? { remote: true, host: remote[1], path: remote[2], spec: to } : { remote: false, path: expandHome(to), spec: to }
}

function checkMember(raw, where, die) {
  onlyFields(raw, MEMBER_FIELDS, where, die)
  const out = {}
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || !SEGMENT.test(raw.name)) die(`${where} name "${raw.name}" is not a path segment: lowercase letters, digits, "." "_" and "-".`)
    out.name = raw.name
  }
  if (raw.site !== undefined) {
    if (typeof raw.site !== "string") die(`${where} site is not a path.`)
    const abs = expandHome(raw.site)
    if (!path.isAbsolute(abs)) die(`${where} site "${raw.site}" is not an absolute path; start it with / or ~/.`)
    out.site = abs
  }
  if (raw.dev !== undefined) out.dev = httpUrl(raw.dev, `${where} dev`, die)
  if (raw.repo !== undefined) {
    if (typeof raw.repo !== "string" || !raw.repo.trim()) die(`${where} repo is not a git address.`)
    out.repo = raw.repo
  }
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || path.isAbsolute(raw.path)) die(`${where} path is not a path inside the repository.`)
    out.path = raw.path
  }
  if (out.path !== undefined && out.repo === undefined) die(`${where} has a path and no repo; path is where the wiki is inside the repo.`)
  if (out.site === undefined && out.repo === undefined) die(`${where} has neither a site nor a repo, so nothing can publish it.`)
  return out
}

/** One library file, checked whole. */
function readLibrary(name, file, die) {
  const raw = readMap(file, die) ?? {}
  onlyFields(raw, LIBRARY_FIELDS, file, die)
  if (typeof raw.base !== "string") die(`${file}: the library has no base.`)
  const resolved = resolveTarget({ base: raw.base }, {}, (m) => die(`${file}: ${m}`))
  const library = {
    name,
    targetName: name,
    base: resolved.base,
    scheme: resolved.scheme,
    slug: resolved.slug,
    from: file,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Wikis",
    access: raw.access === undefined ? {} : checkAccess(raw.access, `${file}: access`, die),
    trustedProxies: raw["trusted-proxies"] === undefined ? [] : cidrs(raw["trusted-proxies"], `${file}: trusted-proxies`, die),
    deploy: null,
    cache: typeof raw.cache === "string" ? expandHome(raw.cache) : null,
    collections: [],
    members: new Map(),
  }
  if (raw.deploy !== undefined) {
    onlyFields(raw.deploy, ["to"], `${file}: deploy`, die)
    if (typeof raw.deploy.to !== "string" || !raw.deploy.to.trim()) die(`${file}: deploy has no "to".`)
    library.deploy = parseDestination(raw.deploy.to.trim())
  }

  const collections = raw.collections ?? {}
  if (!isMapValue(collections)) die(`${file}: collections is not a map of collections.`)
  const paths = []
  const addresses = new Map()
  for (const [key, c] of Object.entries(collections)) {
    const where = `${file}: collection ${key}`
    if (!LIBRARY_NAME.test(key)) die(`${where}: the key is not lowercase letters, digits, "." "_" and "-".`)
    onlyFields(c, COLLECTION_FIELDS, where, die)
    if (typeof c.path !== "string" || !MOUNT.test(c.path)) die(`${where} path "${c.path}" is not a path: segments of lowercase letters, digits, "." "_" and "-", joined by "/".`)
    for (const [other, p] of paths) {
      if (p === c.path) die(`${file}: collections ${other} and ${key} are both at ${c.path}.`)
      if (p.startsWith(`${c.path}/`) || c.path.startsWith(`${p}/`)) die(`${file}: collection ${other} at ${p} and ${key} at ${c.path} are one inside the other.`)
    }
    paths.push([key, c.path])
    const collection = {
      key,
      path: c.path,
      title: typeof c.title === "string" && c.title.trim() ? c.title.trim() : key,
      access: c.access === undefined ? {} : checkAccess(c.access, `${where} access`, die),
      members: [],
    }
    const wikis = c.wikis ?? {}
    if (!isMapValue(wikis)) die(`${where} wikis is not a map of wikis.`)
    for (const [wikiKey, m] of Object.entries(wikis)) {
      if (!KEY.test(wikiKey)) die(`${where}: "${wikiKey}" is not a link key: lowercase letters, digits, "+" "." and "-", starting with a letter.`)
      const member = { key: wikiKey, collection: key, mount: c.path, ...checkMember(m, `${where}: ${wikiKey}`, die) }
      member.name ??= wikiKey
      const before = library.members.get(wikiKey)
      if (before) die(`${file}: "${wikiKey}" is in collections ${before.collection} and ${key}; a wiki is in one collection of a library.`)
      const address = `${c.path}/${member.name}`
      if (addresses.has(address)) die(`${file}: "${addresses.get(address)}" and "${wikiKey}" are both at ${address}/.`)
      addresses.set(address, wikiKey)
      library.members.set(wikiKey, member)
      collection.members.push(wikiKey)
    }
    library.collections.push(collection)
  }
  return library
}

/**
 * Everything the machine layer says.
 *
 *   targets        name -> library {name, base, slug, title, access, trustedProxies, deploy, collections, members, from}
 *   defaultTarget  the name in `awt.yaml`, or null
 *   wikis          key -> {key, site, dev, mount, name, group, libraries: {name -> member}, from}
 *   registry       the same map: every wiki is registered in some library
 *   groupOrder     the default library's collection titles, in order
 *
 * A wiki's own `mount`, `name` and `group` are its membership in the default library, else in the
 * first library that has it; they are what a build for a base given on the command line uses.
 *
 * `die` throws by default so a caller can catch; the CLI passes its own.
 */
export function loadMachine({ dir = configDir(), die = throwing } = {}) {
  const machine = readMap(machineFile(dir), die) ?? {}
  onlyFields(machine, MACHINE_FIELDS, machineFile(dir), die)

  const targets = new Map()
  const libs = librariesDir(dir)
  const names = fs.existsSync(libs) ? fs.readdirSync(libs).filter((f) => /\.ya?ml$/.test(f)).sort() : []
  for (const file of names) {
    const name = file.replace(/\.ya?ml$/, "")
    if (!LIBRARY_NAME.test(name)) die(`${path.join(libs, file)}: "${name}" is not a library name: lowercase letters, digits, "." "_" and "-".`)
    if (targets.has(name)) die(`${libs} has two files for the library "${name}".`)
    targets.set(name, readLibrary(name, path.join(libs, file), die))
  }

  let defaultTarget = null
  if (machine["default-library"] !== undefined) {
    defaultTarget = String(machine["default-library"]).trim() || null
    if (defaultTarget && !targets.has(defaultTarget)) {
      die(`${machineFile(dir)} names "${defaultTarget}", and ${libs} ${targets.size ? `has ${[...targets.keys()].join(", ")}` : "holds no library"}.`)
    }
  }

  // A wiki in several libraries is one checkout: its site and dev must agree wherever they are given.
  const order = defaultTarget ? [targets.get(defaultTarget), ...[...targets.values()].filter((t) => t.name !== defaultTarget)] : [...targets.values()]
  const wikis = new Map()
  for (const library of order) {
    for (const member of library.members.values()) {
      const wiki = wikis.get(member.key) ?? { key: member.key, libraries: {}, from: {} }
      for (const field of ["site", "dev"]) {
        if (member[field] === undefined) continue
        if (wiki[field] !== undefined && wiki[field] !== member[field]) {
          die(`"${member.key}" has ${field} ${member[field]} in ${library.from} and ${wiki[field]} in ${wiki.from[field]}; one wiki is one checkout.`)
        }
        wiki[field] ??= member[field]
        wiki.from[field] ??= library.from
      }
      if (wiki.mount === undefined) {
        wiki.mount = member.mount
        wiki.name = member.name
        wiki.group = library.collections.find((c) => c.key === member.collection).title
      }
      wiki.libraries[library.name] = member
      wikis.set(member.key, wiki)
    }
  }

  const groupOrder = defaultTarget ? targets.get(defaultTarget).collections.map((c) => c.title) : []
  return { dir, targets, defaultTarget, registry: wikis, wikis, groupOrder }
}

// ------------------------------------------------------------------------- addresses

const trim = (s) => s.replace(/\/+$/, "")

/** Where wiki `entry` is served for library `t`: its collection path and name there; for a bare base, its own mount and name. */
export function addressOf(entry, t) {
  if (t.targetName) {
    const member = entry.libraries?.[t.targetName]
    return member ? `${trim(t.base)}/${member.mount}/${member.name}` : undefined
  }
  if (entry.mount && entry.name) return `${trim(t.base)}/${entry.mount}/${entry.name}`
  return undefined
}

/**
 * The published site of `entry` that was built for `t`, which holds the index its links are checked against.
 * It is `build/published/<slug>`. A site published before there was a `build/` is found where it was:
 * `releases/<slug>`, or the project's declared one in `release`, which counts only when it records the
 * address it would have here.
 */
export function releaseFor(entry, t, expectedUrl) {
  if (!entry.site) return undefined
  const hasIndex = (d) => fs.existsSync(path.join(d, "static", "contentIndex.json"))
  const current = path.join(entry.site, PUBLISHED, t.slug)
  if (hasIndex(current)) return current
  const dated = path.join(entry.site, "releases", t.slug)
  if (hasIndex(dated)) return dated
  const standing = path.join(entry.site, "release")
  if (!hasIndex(standing)) return undefined
  try {
    const recorded = JSON.parse(fs.readFileSync(path.join(standing, "static", "awtRelease.json"), "utf8")).url
    return recorded && expectedUrl && trim(recorded) === trim(expectedUrl) ? standing : undefined
  } catch {
    return undefined
  }
}

/** A wiki's dev build index: in `build/dev`, or where an older `awt site serve` put it, in `public`. */
function devIndexFor(site) {
  const current = path.join(site, DEV, "static", "contentIndex.json")
  const old = path.join(site, "public", "static", "contentIndex.json")
  return !fs.existsSync(current) && fs.existsSync(old) ? old : current
}

/**
 * The registry the Quartz plugin reads, from the machine's wikis, for one build.
 *
 *   target   the build's own library (published addresses), or null
 *   serving  a dev server: links go to a wiki's `dev` address, else to the default library
 *
 * Both halves are produced whatever the build is, because the plugin picks one by the target it was
 * derived for. A wiki the library does not hold is left out of that half, and the plugin says so by
 * name when a link needs it.
 */
export function pluginRegistry(machine, { target = null } = {}) {
  const fallback = machine.defaultTarget ? machine.targets.get(machine.defaultTarget) : null
  const out = {}
  for (const entry of machine.wikis.values()) {
    const result = {}

    if (entry.dev) {
      result.dev = entry.dev
      if (entry.site) result.buildIndex = devIndexFor(entry.site)
    } else if (fallback) {
      const url = addressOf(entry, fallback)
      if (url) {
        result.dev = url
        const dir = releaseFor(entry, fallback, url)
        if (dir) result.buildIndex = path.join(dir, "static", "contentIndex.json")
      }
    }

    // Published addresses follow the base/mount/name layout, which a wiki served at its base has no part in.
    if (target && (target.targetName || target.mount)) {
      const url = addressOf(entry, target)
      if (url) {
        result.published = url
        const dir = releaseFor(entry, target, url)
        if (dir) result.publishedIndex = path.join(dir, "static", "contentIndex.json")
      }
    }
    if (Object.keys(result).length) out[entry.key] = result
  }
  return out
}

/**
 * The page that lists every wiki of a library, served at its base: for a build for `target`, that
 * library's base; for a dev server, the default library's. A wiki published at a base of its own has
 * no such page above it, and neither does a machine with no default library, so both are `null`.
 */
export function homeFor(target, { dir = configDir(), die = throwing } = {}) {
  if (target) return target.mount ? `${target.base}/` : null
  const machine = loadMachineIfPresent({ dir, die })
  const fallback = machine?.defaultTarget ? machine.targets.get(machine.defaultTarget) : null
  return fallback ? `${fallback.base}/` : null
}

/** The wikis the machine knows, as the plugin reads them for a build for `target`; none on a machine with no config. */
export function machineRegistryFor(target, die = throwing) {
  const machine = loadMachineIfPresent({ die })
  return machine ? pluginRegistry(machine, { target }) : {}
}

/** The wiki whose site directory is `site`, or null: how a wiki that declares no mount and name still has them. */
export function registeredAt(machine, site) {
  const real = (p) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const here = real(site)
  for (const entry of machine.wikis.values()) {
    if (entry.site && real(entry.site) === here) return entry
  }
  return null
}

// ------------------------------------------------------------------------- writing

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** A member as it is written: site with `~`, and the name only when it is not the key. */
function stored(key, member) {
  const out = {}
  if (member.name !== undefined && member.name !== key) out.name = member.name
  if (member.site !== undefined) out.site = tildeHome(member.site)
  if (member.dev !== undefined) out.dev = member.dev
  if (member.repo !== undefined) out.repo = member.repo
  if (member.path !== undefined) out.path = member.path
  return out
}

/**
 * Write one wiki's entry into a collection of a library file, keeping whatever else the file holds,
 * comments included. Returns `{file, changed}`.
 *
 * The collection has to exist: it carries a path and a title, which are the library's to choose. A
 * wiki in another collection of that library is refused, since moving it changes its address; a
 * different entry in the same collection needs `force`.
 */
export function registerWiki({ dir = configDir(), library, collection, key, entry, force = false, dryRun = false, die = throwing }) {
  if (!KEY.test(key)) die(`"${key}" is not a link key: lowercase letters, digits, "+" "." and "-", starting with a letter.`)
  const machine = loadMachine({ dir, die })
  const lib = machine.targets.get(library)
  if (!lib) die(`no library "${library}" in ${librariesDir(dir)}${machine.targets.size ? `; it has ${[...machine.targets.keys()].join(", ")}` : ""}.`)
  const col = lib.collections.find((c) => c.key === collection)
  if (!col) die(`${lib.from} has no collection "${collection}"${lib.collections.length ? `; it has ${lib.collections.map((c) => c.key).join(", ")}` : ""}. Add it with a path and a title first.`)
  const checked = { ...checkMember(entry, `the entry for ${key}`, die) }

  const existing = lib.members.get(key)
  if (existing && existing.collection !== collection) {
    die(`"${key}" is in the collection ${existing.collection} of ${lib.from}. Run awt site unregister ${key} --library ${library}, then register again.`)
  }
  const name = checked.name ?? key
  for (const other of lib.members.values()) {
    if (other.key !== key && other.mount === col.path && other.name === name) die(`"${other.key}" is already at ${col.path}/${name}/; pass another --name.`)
  }

  const next = stored(key, checked)
  if (existing) {
    const current = stored(key, existing)
    if (same(current, next)) return { file: lib.from, changed: false, dryRun }
    if (!force) {
      const differs = MEMBER_FIELDS.filter((f) => !same(current[f], next[f]))
      die(`"${key}" is registered differently in ${lib.from} (${differs.join(", ")}). Pass --force to replace it.`)
    }
  }

  const doc = parseDocument(fs.readFileSync(lib.from, "utf8"))
  if (!isMap(doc.contents)) doc.contents = doc.createNode({})
  const wikisPath = ["collections", collection, "wikis"]
  if (!isMap(doc.getIn(wikisPath))) doc.setIn(wikisPath, doc.createNode({}))
  doc.setIn([...wikisPath, key], doc.createNode(next))
  if (!dryRun) writeAtomic(lib.from, String(doc))
  return { file: lib.from, changed: true, dryRun }
}

/** Remove a wiki from the library that holds it. */
export function unregisterWiki({ dir = configDir(), library, key, dryRun = false, die = throwing }) {
  const machine = loadMachine({ dir, die })
  const lib = machine.targets.get(library)
  if (!lib) die(`no library "${library}" in ${librariesDir(dir)}.`)
  const existing = lib.members.get(key)
  if (!existing) die(`"${key}" is not in the library ${library}${lib.members.size ? `; it has ${[...lib.members.keys()].join(", ")}` : ""}.`)
  const doc = parseDocument(fs.readFileSync(lib.from, "utf8"))
  doc.deleteIn(["collections", existing.collection, "wikis", key])
  if (!dryRun) writeAtomic(lib.from, String(doc))
  return { file: lib.from, removed: true, collection: existing.collection, dryRun }
}

/**
 * Lift the machine layer from before libraries into `awt.yaml` and `libraries/<target>.yaml`, one
 * library per target, every registered wiki in each, grouped by its group into collections in the
 * order of `groups`. The old files go to `legacy/`. Returns what it wrote, or would write.
 *
 * What does not carry over is reported, not guessed: a wiki with an address of its own (`urls`) is
 * hosted elsewhere and left out, and two wikis that would share an address stop the migration.
 */
export async function migrateMachine({ dir = configDir(), dryRun = false, deployRoot = "~/.local/share/awt/libraries", die = throwing } = {}) {
  const { loadLegacyMachine } = await import("./legacy-machine.js")
  const legacy = ["targets.yaml", "default-target", "groups", "registry.d", "overrides.d"].filter((f) => fs.existsSync(path.join(dir, f)))
  if (!legacy.length) die(`${dir} has no targets.yaml, registry.d or overrides.d to migrate.`)
  if (fs.existsSync(librariesDir(dir)) || fs.existsSync(machineFile(dir))) die(`${dir} already has awt.yaml or libraries/; there is nothing to migrate into.`)
  const old = loadLegacyMachine({ dir, die })

  const slug = (text) => text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[-.]+$/g, "")
  const skipped = []
  const groups = new Map()
  for (const title of old.groupOrder) groups.set(title, [])
  for (const wiki of [...old.wikis.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    if (wiki.urls && Object.keys(wiki.urls).length) {
      skipped.push({ key: wiki.key, reason: "it has an address of its own (urls), so it is hosted elsewhere" })
      continue
    }
    if (!wiki.site) {
      skipped.push({ key: wiki.key, reason: "it has no site directory" })
      continue
    }
    const title = wiki.group ?? wiki.mount ?? wiki.key
    if (!groups.has(title)) groups.set(title, [])
    groups.get(title).push(wiki)
  }

  const collections = {}
  for (const [title, wikis] of groups) {
    if (!wikis.length) continue
    const key = slug(title)
    if (collections[key]) die(`the groups "${collections[key].title}" and "${title}" would both be the collection ${key}.`)
    const members = {}
    const names = new Map()
    for (const w of wikis) {
      const name = w.name ?? w.key
      if (names.has(name)) die(`"${names.get(name)}" and "${w.key}" would both be ${key}/${name}/; give one a name in its registry entry first.`)
      names.set(name, w.key)
      members[w.key] = stored(w.key, { name, site: w.site, dev: w.dev })
    }
    collections[key] = { path: key, title, wikis: members }
  }

  const files = {}
  for (const [name, t] of old.targets) {
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(t.base)
    const doc = new Document({
      base: t.base,
      title: "Wikis",
      ...(local ? { deploy: { to: `${deployRoot}/${name}/` } } : {}),
      collections,
    })
    doc.commentBefore = ` The library "${name}", lifted from targets.yaml and registry.d by awt site migrate --machine.`
    files[path.join("libraries", `${name}.yaml`)] = String(doc)
  }
  const machine = new Document(old.defaultTarget ? { "default-library": old.defaultTarget } : {})
  machine.commentBefore = " Machine settings for awt. Each file in libraries/ is a library, named by its file name."
  files["awt.yaml"] = String(machine)

  if (!dryRun) {
    for (const [rel, text] of Object.entries(files)) writeAtomic(path.join(dir, rel), text)
    fs.mkdirSync(path.join(dir, "legacy"), { recursive: true })
    for (const f of legacy) fs.renameSync(path.join(dir, f), path.join(dir, "legacy", f))
  }
  return { dir, files, moved: legacy, skipped, dryRun }
}

// ------------------------------------------------------------------------ describing

/** What `awt site wikis` shows: the libraries, and each wiki with its address in each and the file it came from. */
/**
 * Each library's release of a wiki in its checkout, and whether a note is newer than it: `fresh`,
 * `stale`, or `unbuilt`. It answers whether a server is behind the working tree, as far as this machine
 * knows: a release is copied when it is published, so one built here is the one a library serves,
 * unless another machine published there since.
 */
function releasesOf(w, machine) {
  if (!w.site) return {}
  // The notes sit beside the site in the wiki's home: <home>/notes and <home>/site.
  const newest = newestNote(path.join(path.dirname(w.site), "notes"))
  const out = {}
  for (const t of machine.targets.values()) {
    const url = addressOf(w, t)
    if (!url) continue
    const dir = releaseFor(w, t, url)
    const at = dir ? builtAt(dir, path.join("static", "awtRelease.json")) : null
    out[t.name] = at === null ? { state: "unbuilt", builtAt: null } : { state: newest > at ? "stale" : "fresh", builtAt: new Date(at).toISOString() }
  }
  return out
}

export function describeMachine(machine, key = null) {
  const targets = [...machine.targets.values()].map((t) => ({
    name: t.name,
    base: t.base,
    title: t.title,
    default: t.name === machine.defaultTarget,
    deploy: t.deploy?.spec ?? null,
    collections: t.collections.map((c) => ({ key: c.key, path: c.path, title: c.title, wikis: c.members })),
    from: t.from,
  }))
  const pick = key ? [...machine.wikis.values()].filter((w) => w.key === key) : [...machine.wikis.values()]
  const wikis = pick
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((w) => ({
      key: w.key,
      mount: w.mount ?? null,
      name: w.name ?? null,
      site: w.site ?? null,
      dev: w.dev ?? null,
      addresses: Object.fromEntries(
        [...machine.targets.values()].map((t) => {
          const url = addressOf(w, t)
          return [t.name, url ? `${url}/` : null]
        }),
      ),
      releases: releasesOf(w, machine),
      from: w.from,
    }))
  return { dir: machine.dir, targets, wikis }
}
