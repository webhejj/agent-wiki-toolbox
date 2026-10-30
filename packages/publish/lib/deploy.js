/**
 * `awt site deploy`: copy a library's releases into its tree, beside the pages and the server config.
 *
 * A library's `deploy.to` is a directory, local or `host:path` over ssh, holding two things a server
 * mounts and nothing else:
 *
 *     <to>/library/                     the tree, laid out as the library's URLs
 *       index.html                      the landing page: the collections
 *       tools/index.html                a collection page: its wikis
 *       tools/aisandbox/…               a release, copied as it is
 *     <to>/conf.d/default.conf          the nginx config: one server over the tree, access per collection
 *
 * In the container they are `/srv/library/` and `/etc/nginx/conf.d/`, and an htpasswd file named in
 * `access.basic` is `/etc/nginx/htpasswd/<name>`, which the host provides. Everything else about the
 * container is the host's.
 *
 * RELEASES STAY IN CHECKOUTS. Publish builds and swaps a release in `<site>/build/published/<slug>/`;
 * deploy copies it with `rsync --delay-updates --delete`, so its new files land together at the end
 * of the transfer and files it no longer has go. The tree is derived: deleting it loses nothing.
 */
import { spawnSync } from "node:child_process"
import nodeFs from "node:fs"
import os from "node:os"
import path from "node:path"

import { addressOf, releaseFor } from "./machine.js"

/** Escape `<` so a JSON document can sit inside a `<script>` element whatever the data holds. */
const jsonForScript = (value) => JSON.stringify(value).replace(/</g, "\\u003c")

/** The access a collection gets: the library's, with each field the collection sets replacing it. */
export const accessFor = (library, collection) => ({ ...library.access, ...collection.access })

/**
 * What to deploy for one library, as data: each wiki and where its release is, and the generated
 * files. Pure over the machine layer and the disk it points at.
 *
 *   only   a wiki key: copy that wiki's release alone, as a publish does after it swaps one in
 */
export function planDeploy({ machine, libraryName, only = null }) {
  const library = machine.targets.get(libraryName)
  if (!library) throw new Error(`no library "${libraryName}"${machine.targets.size ? `; libraries are ${[...machine.targets.keys()].join(", ")}` : ""}.`)
  if (!library.deploy) throw new Error(`the library "${libraryName}" has no deploy.to in ${library.from}.`)

  const wikis = []
  for (const collection of library.collections) {
    for (const key of collection.members) {
      if (only && key !== only) continue
      const member = library.members.get(key)
      const entry = machine.wikis.get(key)
      const url = addressOf(entry, library)
      const base = { key, collection: collection.key, name: member.name, path: `${member.mount}/${member.name}`, url: `${url}/` }
      if (!member.site) {
        wikis.push({ ...base, state: "skipped", reason: "it has no site on this machine; the pipeline builds it from its repo" })
        continue
      }
      const release = releaseFor(entry, library, url)
      if (!release) {
        wikis.push({ ...base, state: "skipped", reason: `no release for this library yet; run awt site publish --library ${libraryName} in it` })
        continue
      }
      wikis.push({ ...base, state: "ready", release })
    }
  }

  const files = {
    [path.join("library", "index.html")]: indexPage({ library, collections: library.collections, depth: 0 }),
    [path.join("conf.d", "default.conf")]: nginxConf(library),
  }
  for (const collection of library.collections) {
    files[path.join("library", ...collection.path.split("/"), "index.html")] = indexPage({ library, collections: [collection], depth: collection.path.split("/").length })
  }
  return { library: libraryName, base: library.base, to: library.deploy, wikis, files }
}

/**
 * The nginx config for a library: one server whose root is the tree, a location per collection with
 * access rules of its own, and the real client address taken from the proxies the library trusts.
 */
export function nginxConf(library) {
  const basePath = new URL(library.base).pathname.replace(/\/+$/, "")
  const rules = (access, indent) => [
    ...(access.allow?.length ? [...access.allow.map((a) => `${indent}allow ${a};`), `${indent}deny all;`] : []),
    ...(access.basic ? [`${indent}auth_basic "${library.title.replace(/"/g, "'")}";`, `${indent}auth_basic_user_file /etc/nginx/htpasswd/${access.basic};`] : []),
  ]
  const serve = (indent) => [
    `${indent}# Quartz emits extensionless addresses, so a page is the file, the file with .html, or a folder's index.`,
    `${indent}try_files $uri $uri.html $uri/index.html =404;`,
  ]
  const own = library.collections.filter((c) => Object.keys(c.access).length)
  const directories = library.collections.flatMap((c) => [c.path, ...c.members.map((k) => `${c.path}/${library.members.get(k).name}`)].map((d) => ({ d, access: accessFor(library, c) })))
  // A directory without its slash would serve its index with every relative link one level off. The
  // static module redirects it to the slash in the content phase, after the access rules; a `return`
  // would answer in the rewrite phase, before them, and tell anyone which wikis exist.
  const redirect = (uri, dir, access) =>
    rules(access, "").length ? [`    location = ${uri} {`, `        alias ${dir};`, ...rules(access, "        "), "    }"] : [`    location = ${uri} { alias ${dir}; }`]
  return [
    `# Generated by awt site deploy for the library "${library.name}" (${library.base}). Do not edit: it is rewritten.`,
    "server {",
    "    listen 80;",
    "    server_name _;",
    "    # The container is reached on another port or behind a proxy, so a redirect must not name one.",
    "    absolute_redirect off;",
    "    # A release is replaced in place; no-cache keeps a browser's copy but revalidates it on every load.",
    '    add_header Cache-Control "no-cache" always;',
    ...(library.trustedProxies.length
      ? ["", "    # The reader's address, as the proxies in front of this server report it.", ...library.trustedProxies.map((p) => `    set_real_ip_from ${p};`), "    real_ip_header X-Forwarded-For;", "    real_ip_recursive on;"]
      : []),
    "",
    ...(basePath ? redirect(basePath, "/srv/library", library.access) : []),
    ...directories.flatMap(({ d, access }) => redirect(`${basePath}/${d}`, `/srv/library/${d}`, access)),
    "",
    `    location ${basePath}/ {`,
    `        alias /srv/library/;`,
    ...rules(library.access, "        "),
    ...serve("        "),
    "    }",
    ...own.flatMap((c) => [
      "",
      `    location ${basePath}/${c.path}/ {`,
      `        alias /srv/library/${c.path}/;`,
      ...rules(accessFor(library, c), "        "),
      ...serve("        "),
      "    }",
    ]),
    "}",
    "",
  ].join("\n")
}

/**
 * The landing page, or a collection's page: the collections given, each with its wikis. The list is
 * written in; whether each wiki has a release is read in the browser from the release's own record,
 * so the page is right after a deploy that copied a new one without being generated again.
 */
export function indexPage({ library, collections, depth }) {
  const up = "../".repeat(depth)
  const sections = collections.map((c) => ({
    title: c.title,
    href: `${up}${c.path}/`,
    wikis: c.members.map((k) => {
      const m = library.members.get(k)
      return { key: k, name: m.name, href: `${up}${c.path}/${m.name}/` }
    }),
  }))
  const single = collections.length === 1 && depth > 0
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(single ? `${collections[0].title} · ${library.title}` : library.title)}</title>
<style>
  :root { --bg: #fbfaf8; --fg: #1f1d1a; --muted: #6f6a62; --line: #e4e0d8; --ok: #2f7d4f; --warn: #a15c10; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #171614; --fg: #ece8e1; --muted: #9d968b; --line: #302d29; --ok: #62b886; --warn: #d8a05a; --card: #1f1d1a; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  p.meta { color: var(--muted); margin: 0 0 2rem; font-size: .9rem; }
  p.meta a { font-weight: 400; text-decoration: underline; }
  h2 { font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 2rem 0 .5rem; }
  h2 a { font-weight: inherit; }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: .5rem; background: var(--card); }
  li { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; padding: .7rem 1rem; border-top: 1px solid var(--line); }
  li:first-child { border-top: 0; }
  a { color: inherit; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
  .state { font-size: .85rem; color: var(--muted); text-align: right; }
  .state.ok { color: var(--ok); }
  .state.warn { color: var(--warn); }
</style>
</head>
<body>
<main>
  <h1 id="title"></h1>
  <p class="meta" id="meta"></p>
  <div id="sections"></div>
</main>
<script>
const LIBRARY = ${jsonForScript({ name: library.name, title: library.title, base: library.base })}
const SINGLE = ${jsonForScript(single)}
const UP = ${jsonForScript(up)}
const SECTIONS = ${jsonForScript(sections)}
document.getElementById('title').textContent = SINGLE ? SECTIONS[0].title : LIBRARY.title
const meta = document.getElementById('meta')
if (SINGLE) { const a = document.createElement('a'); a.href = UP; a.textContent = LIBRARY.title; meta.append('In ', a) }
else meta.textContent = LIBRARY.base + '/'

const root = document.getElementById('sections')
const cells = new Map()
for (const section of SECTIONS) {
  if (!SINGLE) { const h = document.createElement('h2'); const a = document.createElement('a'); a.href = section.href; a.textContent = section.title; h.append(a); root.append(h) }
  const ul = document.createElement('ul'); root.append(ul)
  for (const wiki of section.wikis) {
    const li = document.createElement('li')
    const a = document.createElement('a'); a.textContent = wiki.name; a.href = wiki.href
    const state = document.createElement('span'); state.className = 'state'
    li.append(a, state); ul.append(li)
    cells.set(wiki, state)
  }
}

const when = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString() }
async function refresh() {
  for (const [wiki, cell] of cells) {
    try {
      const r = await fetch(wiki.href + 'static/awtRelease.json', { cache: 'no-store' })
      if (r.ok) { const rec = await r.json(); cell.textContent = 'published ' + when(rec.builtAt); cell.className = 'state ok' }
      else { cell.textContent = 'not deployed yet'; cell.className = 'state warn' }
    } catch { cell.textContent = 'cannot be reached'; cell.className = 'state warn' }
  }
}
refresh(); setInterval(refresh, 15000)
</script>
</body>
</html>
`
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

// ---------------------------------------------------------------------- doing it

const RSYNC = ["-a", "--delete", "--delay-updates"]

/**
 * Carry out a plan: the generated files first, so every collection's directory exists, then each
 * wiki's release. Returns each step with its outcome; a failed rsync stops the deploy.
 *
 * `pages: false` copies the releases alone, which is what a publish does after each swap: the pages
 * and the config change when the library does, not when a wiki is published.
 */
export function runDeploy(plan, { run = spawnSync, fs = nodeFs, pages = true, dryRun = false } = {}) {
  const steps = []
  const to = plan.to
  const dest = (rel) => (to.remote ? `${to.host}:${path.posix.join(to.path, rel)}` : path.join(to.path, rel))
  const rsync = (args) => {
    if (dryRun) return { status: 0 }
    const done = run("rsync", args, { encoding: "utf8" })
    if (done.error?.code === "ENOENT") throw new Error("rsync is not installed.")
    if (done.status !== 0) throw new Error(`rsync ${args.slice(-2).join(" ")} failed: ${String(done.stderr).trim().split("\n").pop()}`)
    return done
  }

  if (pages) {
    if (to.remote) {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), "awt-deploy-"))
      try {
        writeFiles(stage, plan.files, fs)
        rsync(["-a", `${stage}/`, `${to.host}:${to.path.replace(/\/*$/, "/")}`])
      } finally {
        fs.rmSync(stage, { recursive: true, force: true })
      }
    } else if (!dryRun) {
      writeFiles(to.path, plan.files, fs)
    }
    steps.push({ step: "pages", files: Object.keys(plan.files).map(dest) })
  } else if (!to.remote && !dryRun) {
    fs.mkdirSync(path.join(to.path, "library"), { recursive: true })
  }

  for (const w of plan.wikis.filter((x) => x.state === "ready")) {
    const target = dest(path.posix.join("library", w.path))
    if (!to.remote && !dryRun) fs.mkdirSync(path.dirname(target), { recursive: true })
    const started = Date.now()
    rsync([...RSYNC, `${w.release}/`, `${target}/`])
    steps.push({ step: "release", key: w.key, to: `${target}/`, ms: Date.now() - started })
  }
  return steps
}

function writeFiles(root, files, fs) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  }
}

/**
 * After a publish swaps a release in: copy it into the library's tree when the library deploys to a
 * directory on this machine. A library deployed over ssh is deployed by hand, since a save is not a
 * reason to reach another machine. Returns what happened, or null when there is nothing to do.
 */
export function deployAfterPublish({ machine, target, key, run = spawnSync }) {
  if (!machine || !target?.targetName || !key) return null
  const library = machine.targets.get(target.targetName)
  if (!library?.deploy || library.deploy.remote || !library.members.has(key)) return null
  const plan = planDeploy({ machine, libraryName: library.name, only: key })
  const firstTime = !nodeFs.existsSync(path.join(library.deploy.path, "library", "index.html"))
  const steps = runDeploy(plan, { run, pages: firstTime })
  return { library: library.name, steps, skipped: plan.wikis.filter((w) => w.state === "skipped") }
}
