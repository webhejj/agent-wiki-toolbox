/**
 * `awt site serve` — the dev server, run the one way that keeps the shadow honest.
 *
 * The build itself is Quartz's, and the command is not hard to type:
 *
 *     cd site/.quartz-src && node quartz/bootstrap-cli.mjs build \
 *       -d ../../docs/wiki -o ../public --serve --port 8080 --wsPort 3001
 *
 * What is hard to remember is that **the index has to be emitted immediately
 * before it**. `awt site publish` does that; a hand-typed serve command did not, so a
 * dev build compared the rendered pages against whatever `build/awt-index.json` was
 * last written — which after any edit is a disagreement that is not real. This
 * subcommand exists so the two cannot come apart; the emitting happens in `cli`,
 * before this is called.
 *
 * **And again after every edit, for as long as it serves.** Emitting once was not
 * enough: the first save made the index older than the notes, the plugin refused
 * every rebuild from then on, and the server kept serving the page as it was.
 * `cli` hands over `reindex`, this watches the wiki and calls it, and the plugin
 * is told to wait for it — `follow.js` has why the two watchers need that.
 *
 * **`--serve`, always.** A build without it is publish mode, which resolves
 * cross-wiki links to their published URLs rather than to localhost, and Quartz
 * emits extensionless URLs that only the dev server serves.
 *
 * **Ports live in the project, not in the command.** A wiki keeps the same pair
 * every time it is served — a bookmark that breaks between runs is not a bookmark,
 * and two wikis have to be servable at once for cross-wiki links to resolve — so
 * `awt.config.mjs` carries them and `awt site serve` with no arguments is the whole
 * command. A flag still wins, for a one-off second server.
 *
 * **A configured port is used, whatever it is.** Which range a project should pick
 * from is a question about that project's machine, and the answer belongs where
 * the project is being set up — the `wiki-docs` skill carries it. A tool that
 * refused a number the project had already written down would be overruling a
 * decision it was not present for.
 *
 * It refuses to build over a published site for the same reason `publish` refuses
 * to build over `build/dev`: a build in the wrong mode rewrites every
 * cross-wiki link and every page still returns 200.
 *
 * **It also refuses to start on a port somebody already holds**, because Quartz
 * does not. Quartz prints `Started a Quartz server listening at …` and *then*
 * `Port 8100 is already in use`, so the success line comes first and the port
 * answers 200 throughout — from whatever was already bound. When that is a stale
 * server on the same wiki it is hot-reloading the same files, so every page looks
 * current and correct and is not your build. Quartz does exit 1 honestly, but
 * trimming its output through `tail` makes the shell report the pipe's status and
 * the 1 becomes 0. Asked and answered before the build starts instead.
 */

import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { parseArgs } from "node:util"

import { requireProjectRoot } from "./project-root.js"
import { ensureQuartz, quartzDir } from "./bootstrap.js"
import { readDeclaration } from "./declaration.js"
import { writeSiteConfig } from "./site-config.js"
import { homeFor, loadMachineIfPresent, machineRegistryFor, registeredAt } from "./machine.js"
import { DEV, PUBLISHED } from "./layout.js"
import { followNotes, FOLLOWING } from "./follow.js"

/**
 * The port a wiki is served on when the project has not said. High enough to clear
 * the range every framework defaults into, so a project that never configures one
 * still does not collide with whatever else it runs.
 */
export const DEFAULT_PORT = 8100

/**
 * Quartz's hot-reload socket. Derived from the port rather than defaulted flat, so
 * two wikis configured a port apart get sockets a port apart and can run together
 * — which is what a cross-wiki link needs at dev time.
 */
export const wsPortFor = (port) => port + 100

function die(message) {
  console.error(message)
  process.exit(1)
}

/**
 * A port from the command line or the project config.
 *
 * The only thing rejected is a value that is not a port number at all, which is a
 * typo rather than a preference. Which port a project *should* use is not this
 * tool's call.
 */
function port(value, what, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    die(`${what} must be a port number, got "${value}"`)
  }
  return number
}

/** Who is listening on `port`, as `pid` plus how it was started, or null. */
function heldBy(port) {
  const found = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
  const pid = (found.stdout ?? "").trim().split("\n")[0]
  if (found.status !== 0 || !pid) return null
  const how = spawnSync("ps", ["-o", "lstart=,command=", "-p", pid], { encoding: "utf8" })
  return { pid, how: (how.stdout ?? "").trim() }
}

const show = (p) => path.relative(process.cwd(), p) || "."

/**
 * `reindex`, when given, re-emits the index; it is called after each burst of
 * changes under the wiki for as long as the server runs. Without it the index
 * is whatever was emitted before the start, and goes stale on the first edit.
 */
export async function serve(argv = process.argv.slice(2), { reindex } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      wiki: { type: "string" },
      site: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      "ws-port": { type: "string" },
      // What the project's own config said, passed in by `cli` rather than read
      // here: `publish` may not reach `format`, which owns config discovery.
      configPort: { type: "string" },
      configWsPort: { type: "string" },
      // The project's `site` declaration, as JSON, and the directory its relative
      // paths are written against. Passed in by `cli` for the same reason.
      "site-config": { type: "string" },
      project: { type: "string" },
    },
    allowPositionals: false,
  })

  const root = values.wiki && values.site ? null : requireProjectRoot(die)
  const wiki = values.wiki ? path.resolve(values.wiki) : path.join(root, "docs/wiki")
  const site = values.site ? path.resolve(values.site) : path.join(root, "site")
  const out = values.out ? path.resolve(values.out) : path.join(site, DEV)

  if (!fs.existsSync(wiki)) die(`no wiki at ${show(wiki)}`)

  // The safe part only: installs missing/stale dependencies and rewires the
  // derived symlinks, but refuses (via `die`) rather than bootstrapping a
  // project that has never had `awt site setup` run for it at all.
  ensureQuartz(site, die)
  const quartz = quartzDir(site)

  // The release is served by a static host, not built into. Overwriting it with a
  // dev build would leave every cross-wiki link pointing at localhost.
  const resolvedOut = path.resolve(out)
  const published = path.join(site, PUBLISHED)
  if (resolvedOut === published || resolvedOut.startsWith(published + path.sep) || resolvedOut === path.join(site, "release")) {
    die("refusing to build a dev server into a published site: it would write dev links over every page")
  }

  // A flag beats the project's config, which beats the default — the flag is for a
  // one-off second server, not for the everyday case.
  const named = (flag, key) => (values[flag] ? `--${flag}` : `serve.${key} in awt.config.mjs`)
  const httpPort = port(values.port ?? values.configPort, named("port", "port"), DEFAULT_PORT)
  const socketPort = port(values["ws-port"] ?? values.configWsPort, named("ws-port", "wsPort"), wsPortFor(httpPort))

  // The config Quartz reads, derived now so it reflects this declaration and
  // this port. It is what the symlink ensureQuartz wired points at.
  // A wiki that does not name itself is named by its registration on this machine.
  const declared = readDeclaration(values["site-config"], die)
  const registered = declared.self ? null : registeredAt(loadMachineIfPresent({ die }) ?? { registry: new Map() }, site)
  await writeSiteConfig(site, quartz, registered ? { ...declared, self: registered.key } : declared, {
    projectDir: values.project ? path.resolve(values.project) : path.dirname(site),
    port: httpPort,
    serving: true,
    machineRegistry: machineRegistryFor(null, die),
    home: homeFor(null, { die }),
    die,
  })

  const args = [
    "quartz/bootstrap-cli.mjs",
    "build",
    "-d",
    path.relative(quartz, wiki),
    "-o",
    path.relative(quartz, out),
    "--serve",
    "--port",
    String(httpPort),
    "--wsPort",
    String(socketPort),
  ]

  for (const [used, what] of [[httpPort, "port"], [socketPort, "hot-reload socket"]]) {
    const holder = heldBy(used)
    if (!holder) continue
    die(
      `${what} ${used} is already in use, by pid ${holder.pid}:\n` +
        `    ${holder.how}\n` +
        "Stop it, or pass --port / --ws-port for this run.",
    )
  }

  console.log(`wiki: ${show(wiki)}\nsite: ${show(site)}\nserving on http://localhost:${httpPort}`)

  // Inherited stdio and no wait: Quartz's dev server owns the terminal from here,
  // and Ctrl-C should reach it rather than this process.
  const stopFollowing = reindex ? followNotes(wiki, reindex) : () => {}
  const env = reindex ? { ...process.env, [FOLLOWING]: "1" } : process.env
  const child = spawn("node", args, { cwd: quartz, stdio: "inherit", env })

  // Ctrl-C in a terminal signals the whole process group and needs none of this.
  // A programmatic kill of *this* process does not, and the dev server outlives
  // it — holding the port, hot-reloading the same wiki, and answering 200 to
  // whoever looks next. Which is the failure the port check above exists for, so
  // it should not be this command that causes it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      child.kill(signal)
    })
  }

  child.on("exit", (code) => {
    stopFollowing()
    process.exit(code ?? 0)
  })
  return 0
}
