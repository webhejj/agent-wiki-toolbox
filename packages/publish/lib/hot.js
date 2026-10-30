/**
 * `awt site publish --watch`: a release that keeps itself current while someone edits.
 *
 * It is the same build as a one-shot publish, for the same target, kept resident. Quartz holds
 * every parsed note in memory under `--watch` and re-parses only the file that changed, which
 * is what takes a rebuild from about four seconds to about half of one; there is no
 * incremental publish to build, only a process to keep alive.
 *
 * WATCH IS NOT SERVE. `--serve` also writes dev links and starts an HTTP server, and neither
 * is wanted here: the links are the target's, as in any release, and a static server in front
 * of the release directory does the serving. That Quartz can watch without serving is the
 * point; that the plugin took its links from `--serve` is why it needed the target option.
 *
 * QUARTZ BUILDS INTO A WORK DIRECTORY, AND THE RELEASE IS A COPY OF IT. Quartz wipes its output
 * directory when it starts and rewrites files one by one on every rebuild, so a reader of that
 * directory sees the site vanish for the first build and a mix of old and new pages during each
 * one. Each completed build is therefore copied beside the release and swapped into place by a
 * rename, which is what a one-shot publish does with its staging directory. A rebuild that
 * fails leaves the standing release alone.
 *
 * THE PUBLISHED SITE THIS REPLACES IS KEPT ONCE. The first swap keeps what stood as a hidden `-prev` beside it,
 * like a one-shot publish. Later swaps do not rotate it: a previous release that is only the
 * last rebuild is no rollback at all, and the one from before the session is the one worth having.
 *
 * AN INCREMENTAL STATE CAN GO WRONG IN WAYS A COLD BUILD DOES NOT. Deleting a note that others
 * link to makes every later incremental rebuild fail the toolbox's resolver check, under
 * `awt site serve` as well, because Quartz goes on resolving links to a page it no longer has.
 * A cold build of the same notes passes. So a failed rebuild restarts the build from scratch,
 * which is what a person would do, and a build that dies, as one with a fatal error in a note
 * does, starts again at the next change to the notes.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { FOLLOWING, followNotes } from "./follow.js"
import { releaseRecord } from "./target.js"

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g

/** What a line of Quartz's own output says about the build, or null for any other line. */
export function classify(line) {
  const text = line.replace(ANSI, "").trim()
  if (/^Done processing \d+ files/.test(text)) return "built"
  if (/^Done rebuilding in /.test(text)) return "rebuilt"
  if (/^Rebuild failed:/.test(text)) return "failed"
  return null
}

/**
 * Refuse a copy that is not a site, as a one-shot publish does before its swap, but by throwing:
 * that one exits the process, and a resident build has to survive one bad rebuild.
 */
export function check(root) {
  for (const required of ["index.html", path.join("static", "contentIndex.json")]) {
    if (!fs.existsSync(path.join(root, required))) throw new Error(`the build produced no ${required}`)
  }
  let pages = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else if (e.name.endsWith(".html")) pages++
    }
  }
  walk(root)
  if (pages === 0) throw new Error("the build produced no pages")
  return { pages }
}

/** Swap `next` into `out`, keeping nothing: the release that stood is the last rebuild. */
export function replaceRelease(next, out) {
  const old = `${out}.old-${process.pid}`
  const had = fs.existsSync(out)
  if (had) fs.renameSync(out, old)
  fs.renameSync(next, out)
  if (had) fs.rmSync(old, { recursive: true, force: true })
}

/**
 * Run the resident build. Resolves when it is stopped or cannot start, with the exit code.
 *
 *   quartz, wiki, out         as in a one-shot publish
 *   target                    the address being built for, or null
 *   applyScheme, swap         the release's own steps, passed in so this and `release.js` share them
 *   recordPath                where the release records its address, inside the release
 *   say                       where a line about the release goes
 *   reindex                   re-emits the link index after each change to the notes
 *   command                   what runs Quartz: `node`, unless a test stands in for it
 */
export function hotPublish({ quartz, wiki, out, target, applyScheme, swap, recordPath, say, reindex, afterSwap = () => {}, command = "node" }) {
  const base = path.basename(out)
  const dir = path.dirname(out)
  const work = path.join(dir, `.${base}-work`)
  const next = path.join(dir, `.${base}-next`)
  const prev = path.join(dir, `.${base}-prev`)
  for (const leftover of [work, next]) fs.rmSync(leftover, { recursive: true, force: true })

  const args = [
    "quartz/bootstrap-cli.mjs",
    "build",
    "-d",
    path.relative(quartz, wiki),
    "-o",
    path.relative(quartz, work),
    "--watch",
  ]
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("NPM_")) delete env[key]
  if (reindex) env[FOLLOWING] = "1"

  const clock = () => new Date().toTimeString().slice(0, 8)
  const where = (p) => path.relative(process.cwd(), p) || "."

  let child = null
  let first = true
  let stopped = false
  let publishing = false
  let again = false
  let tail = ""
  let done = () => {}

  const publishCopy = () => {
    const started = Date.now()
    fs.rmSync(next, { recursive: true, force: true })
    try {
      fs.cpSync(work, next, { recursive: true })
      applyScheme(next, target)
      fs.writeFileSync(path.join(next, recordPath), `${JSON.stringify(releaseRecord(target), null, 1)}\n`)
      const measured = check(next)
      const kept = first ? swap(next, out, prev) : (replaceRelease(next, out), false)
      say(
        `[${clock()}] ${first ? "published" : "republished"} ${measured.pages} pages in ${Date.now() - started} ms` +
          (kept ? `; the release that stood is kept at ${where(prev)}` : ""),
      )
      first = false
      afterSwap()
    } catch (e) {
      fs.rmSync(next, { recursive: true, force: true })
      say(`[${clock()}] not published: ${String(e.message ?? e).split("\n")[0]}. The standing release is untouched.`)
    }
  }

  // One copy at a time. A build that completes during a copy schedules exactly one more, so a
  // burst of saves ends in one release that has all of them and not a queue of stale ones.
  const publishNow = () => {
    if (stopped) return
    if (publishing) {
      again = true
      return
    }
    publishing = true
    try {
      publishCopy()
    } finally {
      publishing = false
    }
    if (again) {
      again = false
      publishNow()
    }
  }

  const launch = () => {
    fs.rmSync(work, { recursive: true, force: true })
    const c = spawn(command, args, { cwd: quartz, stdio: ["ignore", "pipe", "pipe"], env })
    child = c
    // Quartz prints a failed rebuild to stderr and the others to stdout, so both are read for events.
    const feed = (stream, write) => {
      let pending = ""
      stream.on("data", (chunk) => {
        if (child !== c) return
        pending += chunk.toString()
        const lines = pending.split("\n")
        pending = lines.pop()
        for (const line of lines) {
          tail = `${tail}\n${line}`.slice(-2000)
          write(`${line}\n`)
          const kind = classify(line)
          if (kind === "built" || kind === "rebuilt") publishNow()
          else if (kind === "failed") restart("the rebuild failed")
        }
      })
    }
    feed(c.stdout, (text) => process.stdout.write(text))
    feed(c.stderr, (text) => process.stderr.write(text))
    c.on("exit", (code, signal) => {
      // Replaced on purpose: whoever replaced it already said so.
      if (child !== c) return
      child = null
      if (stopped) return done(0)
      if (first) {
        say(`\nthe build ended before it produced a release; nothing was published.\n${tail.trim()}`)
        return done(signal ? 1 : code || 1)
      }
      say(
        `[${clock()}] the build ended (${signal ?? `exit ${code}`}); the standing release is untouched.\n` +
          `${tail.trim().split("\n").slice(-4).join("\n")}\nIt starts again at the next change to the notes.`,
      )
    })
  }

  // After a failed rebuild the incremental state cannot be trusted, so start over from the notes.
  const restart = (why) => {
    if (stopped || !child) return
    say(`[${clock()}] ${why}; the standing release is untouched. Restarting the build from scratch.`)
    const old = child
    child = null
    old.kill("SIGTERM")
    launch()
  }

  // Each change to the notes re-emits the index, and wakes a build that ended.
  const stopFollowing = followNotes(wiki, () => {
    if (reindex) reindex()
    if (!child && !stopped) launch()
  })

  const stop = (signal) => {
    stopped = true
    if (child) child.kill(signal)
    else done(0)
  }
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => stop(signal)
    process.on(signal, handler)
    return [signal, handler]
  })

  return new Promise((resolve) => {
    done = (code) => {
      stopped = true
      stopFollowing()
      for (const [name, handler] of handlers) process.off(name, handler)
      for (const leftover of [work, next]) fs.rmSync(leftover, { recursive: true, force: true })
      say(`\nstopped; the release at ${where(out)} is the last one published.`)
      resolve(code)
    }
    launch()
  })
}
