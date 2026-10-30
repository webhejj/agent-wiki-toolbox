/**
 * The machine layer as it was before libraries, read only so `awt site migrate --machine` can lift it.
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
import path from "node:path"
import { parseDocument } from "yaml"

import { configDir, expandHome } from "./machine.js"
import { resolveTarget, SEGMENT } from "./target.js"

const KEY = /^[a-z][a-z0-9+.-]*$/
const FIELDS = ["mount", "name", "site", "dev", "urls", "group"]
const TARGET_NAME = /^[a-z0-9][a-z0-9._-]*$/

const throwing = (message) => {
  throw new Error(message)
}

/** The machine layer if there is a config directory at all, else null: a machine with none is not an error. */
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
export function loadLegacyMachine({ dir = configDir(), die = throwing } = {}) {
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

