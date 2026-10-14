/**
 * The machine layer: what is true of this machine's wikis, kept in `~/.config/awt/`.
 *
 *     targets.yaml        the deployments: name -> base
 *     default-target      one line: the target used when none is named
 *     registry.d/*.yaml   wikis on this machine, written by `awt site register`
 *     overrides.d/*.yaml  hand-written, merged per field over the registry
 *
 * YAML because it takes comments, and `register` rewrites its own entry in a file a person may
 * have annotated: the `yaml` package edits a document without losing them, which `awt frontmatter`
 * already depends on. Every file is a map keyed by the link key.
 *
 *     dios:
 *       mount: shelton
 *       name: dios
 *       site: ~/Dev/Projects/Shelton/…/wiki/site    # where its releases are
 *       dev: http://localhost:8101                  # its running `awt site serve`, if any
 *       urls: {public: https://…}                   # an address per target, for a wiki hosted elsewhere
 *       group: Tools                                # the section of the landing page; best set in overrides.d
 *
 * `groups` beside them lists group names one per line, in the order the landing page shows them.
 *
 * A COLLISION IS AN ERROR, NOT AN OVERRIDE. The same key in two registry files, two keys with one
 * mount and name, and a duplicate key inside a file all stop the load and name both places.
 * Overrides are the one place a later file wins, and they win per field, and per target in `urls`,
 * so an override made for `local` cannot reach a build for `public`.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Document, isMap, parseDocument } from "yaml"

import { DEV, PUBLISHED } from "./layout.js"
import { resolveTarget, SEGMENT } from "./target.js"

export const KEY = /^[a-z][a-z0-9+.-]*$/
const FIELDS = ["mount", "name", "site", "dev", "urls", "group"]
const TARGET_NAME = /^[a-z0-9][a-z0-9._-]*$/

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

/** The machine layer if there is a config directory at all, else null: a machine with none is not an error. */
export function loadMachineIfPresent({ dir = configDir(), die = throwing } = {}) {
  return fs.existsSync(dir) ? loadMachine({ dir, die }) : null
}

/** The target named in `default-target`, without loading anything else. */
export function readDefaultTarget(dir = configDir()) {
  const file = path.join(dir, "default-target")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0].trim() || null : null
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
  if (typeof value !== "object" || Array.isArray(value)) die(`${file}: expected a map of keys, found ${Array.isArray(value) ? "a list" : typeof value}.`)
  return value
}

const files = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort()
        .map((name) => path.join(dir, name))
    : []

const httpUrl = (value, where, die) => {
  if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value)) die(`${where} is not an http or https address: ${JSON.stringify(value)}`)
  return value.replace(/\/+$/, "")
}

/** One entry, checked field by field. Unknown fields are refused: a typo is otherwise a silent no-op. */
function checkEntry(entry, where, die) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) die(`${where} is not a map of fields.`)
  const out = {}
  for (const [field, value] of Object.entries(entry)) {
    if (!FIELDS.includes(field)) die(`${where} has a field "${field}"; the fields are ${FIELDS.join(", ")}.`)
    if (field === "mount" || field === "name") {
      if (typeof value !== "string" || !SEGMENT.test(value)) die(`${where} ${field} "${value}" is not a path segment: lowercase letters, digits, "." "_" and "-".`)
      out[field] = value
    } else if (field === "site") {
      if (typeof value !== "string") die(`${where} site is not a path.`)
      const abs = expandHome(value)
      if (!path.isAbsolute(abs)) die(`${where} site "${value}" is not an absolute path; start it with / or ~/.`)
      out.site = abs
    } else if (field === "group") {
      if (typeof value !== "string" || !value.trim()) die(`${where} group is not a name.`)
      out.group = value.trim()
    } else if (field === "dev") {
      out.dev = httpUrl(value, `${where} dev`, die)
    } else {
      if (value === null || typeof value !== "object" || Array.isArray(value)) die(`${where} urls is not a map from target name to address.`)
      out.urls = Object.fromEntries(Object.entries(value).map(([t, u]) => [t, httpUrl(u, `${where} urls.${t}`, die)]))
    }
  }
  return out
}

function readLayer(dir, die) {
  /** key -> {fields, from: {field: file}} in file order, with the file of each key, for the collision check. */
  const entries = new Map()
  for (const file of files(dir)) {
    const map = readMap(file, die) ?? {}
    for (const [key, raw] of Object.entries(map)) {
      if (!KEY.test(key)) die(`${file}: "${key}" is not a link key: lowercase letters, digits, "+" "." and "-", starting with a letter.`)
      const fields = checkEntry(raw, `${file}: ${key}`, die)
      const from = {}
      for (const field of Object.keys(fields)) {
        if (field === "urls") for (const t of Object.keys(fields.urls)) from[`urls.${t}`] = file
        else from[field] = file
      }
      entries.set(`${file}\0${key}`, { key, file, fields, from })
    }
  }
  return [...entries.values()]
}

/**
 * Everything the machine layer says.
 *
 *   targets        name -> {name, base, slug, from}
 *   defaultTarget  the name in `default-target`, or null
 *   registry       key -> {key, ...fields, from}   the registered wikis, before overrides
 *   wikis          key -> {key, ...fields, from}   registry with overrides merged per field
 *
 * `die` throws by default so a caller can catch; the CLI passes its own.
 */
export function loadMachine({ dir = configDir(), die = throwing } = {}) {
  const targets = new Map()
  const targetsFile = path.join(dir, "targets.yaml")
  for (const [name, raw] of Object.entries(readMap(targetsFile, die) ?? {})) {
    if (!TARGET_NAME.test(name)) die(`${targetsFile}: "${name}" is not a target name: lowercase letters, digits, "." "_" and "-".`)
    if (raw === null || typeof raw !== "object" || typeof raw.base !== "string") die(`${targetsFile}: target "${name}" has no base.`)
    const resolved = resolveTarget({ base: raw.base }, {}, (m) => die(`${targetsFile}: target "${name}": ${m}`))
    targets.set(name, { name, targetName: name, base: resolved.base, scheme: resolved.scheme, slug: resolved.slug, from: targetsFile })
  }

  let defaultTarget = null
  const defaultFile = path.join(dir, "default-target")
  if (fs.existsSync(defaultFile)) {
    defaultTarget = fs.readFileSync(defaultFile, "utf8").split("\n")[0].trim() || null
    if (defaultTarget && !targets.has(defaultTarget)) {
      die(`${defaultFile} names "${defaultTarget}", and targets.yaml ${targets.size ? `has ${[...targets.keys()].join(", ")}` : "defines none"}.`)
    }
  }

  const groupsFile = path.join(dir, "groups")
  const groupOrder = fs.existsSync(groupsFile)
    ? fs.readFileSync(groupsFile, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
    : []

  const registry = new Map()
  const seenAt = new Map()
  for (const { key, file, fields, from } of readLayer(path.join(dir, "registry.d"), die)) {
    if (registry.has(key)) die(`the wiki "${key}" is registered twice: ${seenAt.get(key)} and ${file}. Unregister one.`)
    registry.set(key, { key, ...fields, from })
    seenAt.set(key, file)
  }
  const identity = new Map()
  for (const entry of registry.values()) {
    if (!entry.mount || !entry.name) continue
    const id = `${entry.mount}/${entry.name}`
    if (identity.has(id)) die(`"${identity.get(id)}" and "${entry.key}" are both ${id}; two wikis cannot share a mount and name (${seenAt.get(entry.key)}).`)
    identity.set(id, entry.key)
  }

  // Overrides win per field, and per target inside `urls`. A key with no registry entry is allowed: a
  // wiki that exists only as an address, hosted somewhere this machine does not build.
  const wikis = new Map([...registry].map(([key, e]) => [key, { ...e, urls: { ...(e.urls ?? {}) }, from: { ...e.from } }]))
  for (const { key, fields, from } of readLayer(path.join(dir, "overrides.d"), die)) {
    const base = wikis.get(key) ?? { key, urls: {}, from: {} }
    for (const [field, value] of Object.entries(fields)) {
      if (field === "urls") Object.assign(base.urls, value)
      else base[field] = value
    }
    Object.assign(base.from, from)
    wikis.set(key, base)
  }
  for (const entry of wikis.values()) if (!Object.keys(entry.urls ?? {}).length) delete entry.urls

  return { dir, targets, defaultTarget, registry, wikis, groupOrder }
}

// ------------------------------------------------------------------------- addresses

const trim = (s) => s.replace(/\/+$/, "")

/** Where wiki `entry` is served for target `t`: its own address for that target, else base/mount/name. */
export function addressOf(entry, t) {
  // Only a target's own name keys `urls`; a build's `name` is the wiki's, and an explicit base has no target name.
  const own = t.targetName ? entry.urls?.[t.targetName] : undefined
  if (own) return trim(own)
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
 *   target   the build's own target (published addresses), or null
 *   serving  a dev server: links go to a wiki's `dev` address, else to the default target
 *
 * Both halves are produced whatever the build is, because the plugin picks one by the target it was
 * derived for. An entry the machine cannot give an address for is left out of that half, and the
 * plugin says so by name when a link needs it.
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
 * The page that lists every wiki on a host, which `awt site host` serves at the base: for a
 * build for `target`, that target's base; for a dev server, the default target's. A wiki
 * published at a base of its own has no such page above it, and neither does a machine
 * with no default target, so both are `null`.
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

/**
 * The registered wiki whose site directory is `site`, or null. This is how a wiki that declares no mount
 * and name still has them: the machine that registered it knows who it is.
 */
export function registeredAt(machine, site) {
  const real = (p) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const here = real(site)
  for (const entry of machine.registry.values()) {
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

/**
 * Write one wiki's entry into `registry.d/<mount>.yaml`, keeping whatever else the file holds,
 * comments included. Returns `{file, changed, created}`.
 *
 * An entry already registered under that key in another file is an error: moving a wiki to another
 * mount is an unregister and a register, and doing it silently would leave two files disagreeing.
 * A different entry in the same file needs `force`.
 */
export function registerWiki({ dir = configDir(), key, entry, force = false, dryRun = false, die = throwing }) {
  if (!KEY.test(key)) die(`"${key}" is not a link key: lowercase letters, digits, "+" "." and "-", starting with a letter.`)
  const checked = checkEntry(entry, `the entry for ${key}`, die)
  if (!checked.mount || !checked.name) die("a registered wiki needs a mount and a name.")
  const machine = loadMachine({ dir, die })

  const file = path.join(dir, "registry.d", `${checked.mount}.yaml`)
  const existing = machine.registry.get(key)
  const where = existing && Object.values(existing.from)[0]
  if (existing && where !== file) die(`"${key}" is registered in ${where}. Run awt site unregister ${key}, then register again.`)

  for (const other of machine.registry.values()) {
    if (other.key !== key && other.mount === checked.mount && other.name === checked.name) {
      die(`"${other.key}" is already ${checked.mount}/${checked.name}; pick another name or unregister it.`)
    }
  }

  const stored = {}
  for (const field of FIELDS) if (checked[field] !== undefined) stored[field] = field === "site" ? tildeHome(checked.site) : checked[field]
  if (existing) {
    const current = {}
    for (const field of FIELDS) if (existing[field] !== undefined) current[field] = field === "site" ? tildeHome(existing.site) : existing[field]
    if (same(current, stored)) return { file, changed: false, created: false, dryRun }
    if (!force) {
      const differs = FIELDS.filter((f) => !same(current[f], stored[f]))
      die(`"${key}" is registered differently in ${file} (${differs.join(", ")}). Pass --force to replace it.`)
    }
  }

  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const doc = text ? parseDocument(text) : new Document({})
  if (!text) doc.commentBefore = ` Wikis under the "${checked.mount}" mount, written by awt site register.\n Comments you add stay; an entry is rewritten when it is registered again.`
  if (!isMap(doc.contents)) doc.contents = doc.createNode({})
  doc.contents.set(key, doc.createNode(stored))
  if (!dryRun) writeAtomic(file, String(doc))
  return { file, changed: true, created: !text, dryRun }
}

/** Remove a wiki's entry from the registry file that holds it. A file left with no wikis goes too. */
export function unregisterWiki({ dir = configDir(), key, dryRun = false, die = throwing }) {
  const machine = loadMachine({ dir, die })
  const existing = machine.registry.get(key)
  if (!existing) die(`"${key}" is not registered${machine.registry.size ? `; registered: ${[...machine.registry.keys()].join(", ")}` : ""}.`)
  const file = Object.values(existing.from)[0]
  const doc = parseDocument(fs.readFileSync(file, "utf8"))
  // A comment directly above the first entry, with no blank line between, belongs to that entry as
  // far as YAML is concerned and would go with it. It is far more often a header for the file, and
  // a person's text is not something to lose quietly, so it becomes the file's header instead.
  const first = doc.contents.items[0]
  if (first && first.key?.value === key && first.key.commentBefore) {
    doc.commentBefore = [doc.commentBefore, first.key.commentBefore].filter(Boolean).join("\n")
  }
  doc.contents.delete(key)
  const last = doc.contents.items.length === 0
  if (!dryRun) {
    if (last) fs.rmSync(file)
    else writeAtomic(file, String(doc))
  }
  return { file, removed: true, fileRemoved: last, dryRun }
}

// ------------------------------------------------------------------------ describing

/**
 * What `awt site wikis` shows: the targets, and each wiki with the address it has for each target and
 * the file every field came from.
 */
export function describeMachine(machine, key = null) {
  const targets = [...machine.targets.values()].map((t) => ({ name: t.name, base: t.base, default: t.name === machine.defaultTarget, from: t.from }))
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
      from: w.from,
    }))
  return { dir: machine.dir, targets, wikis }
}
