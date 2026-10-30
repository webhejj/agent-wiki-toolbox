/**
 * Every operation the toolbox has, as one subcommand of the one binary. Names are
 * `splitByHeading` in the library, `split_by_heading` on the MCP surface and
 * `split` here.
 *
 * A command is data: a name, one line of summary, a usage string, how many
 * arguments it takes, an option map for `parseArgs`, and a `run`. `awt --help` is
 * generated from that list, so every command is listed. Two optional fields shape
 * the surface rather than the call: `group` puts a command under a `GROUPS` entry
 * and it is then invoked as `awt <group> <name>`, and `section` is the heading it
 * is listed under.
 *
 * `positionals` is a count, or `'any'` for the three that are open-ended. It is
 * declared rather than inferred because an unexpected argument was silently
 * dropped by four commands — `awt check ../other-wiki` checked this one and said
 * nothing — and a count a command states is also a count a test can read.
 *
 * The CLI is not a mirror of the packages. `move` here is `moveNote`,
 * `renameNote` or `moveNotes` depending on what it is given, `site index` is a
 * `core` function grouped by what consumes it, and the MCP surface stays flat
 * with its own names.
 */
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {basename, dirname, resolve as resolvePath} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {parse as parseYaml, stringify as stringifyYaml} from 'yaml'

import {check, loadWorkspace, measure, query, writeIndexArtifact} from '@agent-wiki-toolbox/core'
import {
  AMBIGUOUS_CONFIG,
  collectStream,
  layoutFrom,
  loadProjectConfig,
  resolveLayout,
  resolveProjectConfig,
  runFormat,
} from '@agent-wiki-toolbox/format'
import {connections, resolve as resolveLink, search} from '@agent-wiki-toolbox/mcp'
import {
  buildListing,
  deleteNote,
  frontmatter,
  mergeFiles,
  moveNote,
  moveNotes,
  renameNote,
  renameTag,
  splitByHeading,
} from '@agent-wiki-toolbox/verbs'

/**
 * The notes a command works on: `--workspace`, else `$AWT_WORKSPACE`, else the
 * project's own layout, else the cwd.
 *
 * The third step lets `awt check` run from a repo root and mean the wiki: the
 * nearest `awt.config.mjs` names the home and the notes are a fixed name inside it.
 *
 * The fourth is the one that can be confidently wrong, and it announces itself.
 */
async function notesDirFor(values) {
  const explicit = values.workspace ?? process.env.AWT_WORKSPACE
  if (explicit) return namedWorkspace(explicit, values.workspace ? '-w' : '$AWT_WORKSPACE')
  const layout = await resolveLayout()
  if (layout) return layout.notesDir
  announceFallback()
  return process.cwd()
}

/**
 * A workspace someone named, or a refusal in the tool's own words.
 *
 * Unchecked, a `-w` naming a file or a directory that is not there travelled as
 * far as `readdir` and came back as node's `ENOTDIR: not a directory, scandir
 * '...'` through the generic catch in `awt.mjs` — the caller's mistake described
 * from inside the call it broke, with nothing in it naming the flag that caused
 * it. `parseErrorMessage` is the precedent and the reason: `-w` is on every
 * command that works on a wiki, so getting it wrong is a real question about the
 * tool rather than a typo, and it is worth answering as one.
 */
function namedWorkspace(path, source) {
  const dir = resolvePath(path)
  const refuse = (problem, sentence) => {
    const error = new Error(`${source} names ${dir}, which ${problem}. ${sentence}`)
    error.exitCode = 2
    throw error
  }
  if (!existsSync(dir)) refuse('is not there', 'It names the notes directory to work on.')
  if (!statSync(dir).isDirectory()) refuse('is a file', 'It names the notes directory, not a note inside it.')
  return dir
}

/**
 * Say that the notes are the current directory because nothing else said so.
 *
 * This is the finding the argument-surface audit came from. `awt check` run from
 * `/tmp`, with no project anywhere above it, reported *197 notes, 835 links, 62
 * problems* — every one of them a fixture left in half a dozen sessions'
 * scratchpads, and the report indistinguishable in shape from a real one. An
 * agent that runs a command from the wrong place gets no signal that it did.
 *
 * Once per process, on stderr, so `--json` on stdout stays a clean document, and
 * suppressible the way `warnLegacy` is.
 */
let announcedFallback = false
function announceFallback() {
  if (announcedFallback || process.env.AWT_QUIET_WORKSPACE) return
  announcedFallback = true
  process.stderr.write(
    `awt: no awt.config.mjs here or in any parent, so ${process.cwd()} is being read as a notes directory.\n` +
      '  Whatever markdown is under it is the wiki, and the answer will look exactly like a real one.\n' +
      '  Pass -w <notes>, or run this from inside the project. AWT_QUIET_WORKSPACE=1 silences this.\n',
  )
}

/** The whole layout, for the commands that need the site as well as the notes. */
async function layoutFor(command, values) {
  const layout = await resolveLayout()
  if (layout) return layout
  if (values.wiki && values.site) return null
  process.stderr.write(
    `awt ${command}: no awt.config.mjs here or in any parent, and no site/quartz.config.yaml either.\n` +
      '  Run this from inside the project, or pass --wiki and --site.\n',
  )
  return undefined
}

/**
 * **The short flags that exist, and nothing else may add one.**
 *
 * A short flag is earned by frequency across the whole tool, not by one command's
 * convenience — `-w` is on every command that works on a wiki and qualifies twice
 * over. `-q` is on one command and does not, but it is kept: removing it breaks
 * muscle memory to enforce a rule nobody is hurt by, and the rule it offends is
 * about *adding* the next one. Declaring the set is what makes that distinction
 * enforceable instead of a sentence in a note.
 *
 * `-c` went with `--check`, which it shortened. It was not removed on the short
 * flag's own account.
 *
 * A letter means the same thing everywhere, which is the other half of the test.
 */
export const SHORT_FLAGS = {w: 'workspace', q: 'quiet'}

/**
 * **Flags allowed to share a name with a command, and why. Currently none.**
 *
 * The rule is that they do not: `awt check` and `awt fmt --check` were unrelated
 * operations, and a reader who knew one learned the wrong thing about the other.
 * `--check` lived here for one release, while a `Stop` hook installed before the
 * rename still typed it; the install of 2026-09-11 replaced that hook and the flag
 * went. An empty register is the honest state, and it is kept rather than deleted
 * because it is where the next exception gets argued instead of smuggled.
 */
export const NAME_COLLISIONS = {}

/**
 * **Flags this campaign renamed, and what they are now.**
 *
 * Not deprecation — neither spelling still works — but an answer for the one
 * person or hook that types the old one. `parseErrorMessage` is the precedent:
 * node's text for an unknown option ends in advice about `--` that is right for
 * someone with a file called `--check` and wrong for everyone else. Entries come
 * out when nothing types them, the way `--check` itself came out of the register
 * above.
 */
export const RENAMED_FLAGS = {
  'fmt --check': '--dry-run',
  'site serve --wsPort': '--ws-port',
}

const WORKSPACE_OPTION = {workspace: {type: 'string', short: 'w'}}
const OUTPUT_OPTIONS = {json: {type: 'boolean', default: false}}
const SITE_OPTIONS = {wiki: {type: 'string'}, site: {type: 'string'}}
// The address a release is built for. `--wiki` is taken by the notes to render, so the wiki's
// own name under its mount is `--name`.
const TARGET_OPTIONS = {base: {type: 'string'}, mount: {type: 'string'}, name: {type: 'string'}, library: {type: 'string'}, target: {type: 'string'}}

/** The library a command names: --library, or --target, its name from before libraries. Both is a refusal. */
function libraryFlag(command, values) {
  if (values.library !== undefined && values.target !== undefined && values.library !== values.target) {
    process.stderr.write(`awt site ${command}: --library and --target name the same thing; pass --library.\n`)
    return null
  }
  return values.library ?? values.target
}

/**
 * The one group. A group is a namespace, not an alias — `awt serve` is gone, not
 * deprecated — and **its options are the definition of what it is**: `site`
 * inherits a flag family nothing else has, which is why the graph reads were left
 * flat. A group whose options are the tool's defaults would define nothing.
 *
 * `declines` is not academic: `site setup` acts on the site alone, and inheriting
 * a `--wiki` it would ignore breaks the rule that a command does not accept what
 * it cannot act on.
 */
export const GROUPS = [
  {
    name: 'site',
    summary: 'The rendered site: set it up, build it, serve it, feed it the index',
    options: SITE_OPTIONS,
    text: {
      wiki: "the notes to render (default: the project's rootDir/notes)",
      site: 'the site directory to build in (default: rootDir/site)',
    },
  },
]

/** How a command is typed. The only place that knows groups nest. */
export function commandPath(command) {
  return command.group ? [command.group, command.name] : [command.name]
}

/** A command's own options, plus whatever its group hands down and it did not decline. */
export function optionsFor(command) {
  const group = GROUPS.find((entry) => entry.name === command.group)
  if (!group) return command.options ?? {}
  const inherited = Object.fromEntries(
    Object.entries(group.options).filter(([name]) => !command.declines?.includes(name)),
  )
  return {...inherited, ...(command.options ?? {})}
}

/** The order the sections are printed in, which is roughly the order of a day's work. */
export const SECTIONS = ['Ask', 'Change', 'Format', 'Publish', 'Agents']

/**
 * The options more than one command shares, described once.
 *
 * **A usage line names only what is particular to its command**, and the help
 * renderer appends whichever of these that command actually declares. Written by
 * hand into each usage string, they went three ways at once: `--workspace` shown by
 * four commands and omitted by the ten others that take it, `--json` by four of the
 * eleven, `--dry-run` by none of the seven. A usage line you cannot read as
 * complete is worse than a short one — it is what made `awt search --help` look
 * like evidence that `search` has no `-w`.
 */
export const COMMON_OPTIONS = [
  {
    name: 'workspace',
    flags: '-w, --workspace DIR',
    text: "the notes to work on (default: $AWT_WORKSPACE, else the project's rootDir/notes, else here)",
  },
  {name: 'json', flags: '    --json', text: 'JSON output'},
  {name: 'dry-run', flags: '    --dry-run', text: 'report what it would do, write nothing'},
]

function emit(values, value, human) {
  if (values.json) {
    process.stdout.write(`${JSON.stringify(value, null, 1)}\n`)
    return
  }
  // Nothing to say is said with nothing: `check --quiet` on a healthy wiki should
  // be silent, not a blank line for a script to strip.
  const text = human(value)
  if (text) process.stdout.write(`${text}\n`)
}

/**
 * What a formatting run came to, in one line.
 *
 * `fmt` is quiet by default, so a clean run prints nothing at all — and silence
 * reads as *it did nothing* rather than *there was nothing to do*. The counts are
 * what tell those apart, and they go **above** the report for the same reason
 * `check`'s verdict does: nothing else on this binary makes you read to the end to
 * find out whether it worked, and the end is what a `| head` throws away.
 */
function verdict({files, problems}, checking) {
  const counted = `${files} file${files === 1 ? '' : 's'}`
  // **Format mode used to drop `problems` on the floor**, so `awt fmt a.md
  // nowhere.md` answered "2 files formatted" with one of them not there — and
  // this line is deliberately above the report, so `| head -1` saw exactly the
  // sentence that was false. `--json` had `ok: false` and `problems: 1` all
  // along, which is the worst way round: the script could see it and the person
  // could not. The word is `processed` rather than `formatted` because a file
  // with a problem is one this did not format.
  if (problems) return `${counted} ${checking ? 'checked' : 'processed'}, ${problems} with problems`
  return checking ? `${counted} checked, all clean` : `${counted} formatted`
}

/** A verb's report, rendered for a person. The structured form is `--json`. */
function reportLines(report) {
  const lines = [`${report.verb}: ${report.ok ? 'ok' : 'incomplete'}${report.dryRun ? ' (dry run)' : ''}`]
  const list = (label, values) => {
    if (values?.length) lines.push(`  ${label}: ${values.join(', ')}`)
  }
  list('created', report.created)
  list('changed', report.changed)
  list('deleted', report.deleted)
  for (const entry of report.skipped ?? []) lines.push(`  SKIPPED ${entry.path}: ${entry.reason}`)
  for (const entry of report.unresolved ?? []) {
    lines.push(`  UNRESOLVED ${entry.from}:${entry.line} [[${entry.target}]]: ${entry.reason}`)
  }
  for (const note of report.notes ?? []) lines.push(`  note: ${note}`)
  // The code, where the verb gave one. A person scanning a refusal wants the
  // sentence; a person who then has to ask about it wants the name to ask under,
  // and `--json` is not the only place it should exist.
  if (report.code) lines.push(`  code: ${report.code}`)
  if (!report.ok) lines.push('  the verb can be re-run once the reason above is dealt with')
  return lines.join('\n')
}

/** A verb that refuses reports in the same shape as one that finished partially. */
/** A wrong invocation: nothing runs, and the exit code says it was the call. */
function usageError(message) {
  const error = new Error(message)
  error.exitCode = 2
  throw error
}

/**
 * A move plan as JSON: the MCP `pairs` shape, read from a file or from stdin as
 * `-`. One shape on both surfaces, so a plan an agent built for one runs on the
 * other.
 */
async function readPlan(source) {
  let text
  if (source === '-') {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    text = Buffer.concat(chunks).toString('utf8')
  } else {
    if (!existsSync(source)) usageError(`--plan names ${resolvePath(source)}, which is not there.`)
    text = readFileSync(source, 'utf8')
  }
  let pairs
  try {
    pairs = JSON.parse(text)
  } catch (error) {
    usageError(`--plan is not JSON: ${error.message}`)
  }
  const shaped =
    Array.isArray(pairs) &&
    pairs.every((pair) => pair && typeof pair.from === 'string' && typeof pair.to === 'string')
  if (!shaped) usageError('--plan takes a JSON array of {"from": "...", "to": "..."} pairs.')
  return pairs
}

/** Does a `move` source name a folder of the notes rather than a note? */
function isFolder(notesDir, path) {
  if (path.endsWith('/')) return true
  const absolute = resolvePath(notesDir, path)
  return existsSync(absolute) && statSync(absolute).isDirectory()
}

/**
 * A folder move as the plan it stands for: one pair per note under the folder,
 * listed when the verb runs, so a note added since the caller looked still moves.
 * Only notes are in the index, so anything else in the folder stays where it is,
 * and the report names the folder it was left in.
 */
function folderPlan(workspace, from, to) {
  const trim = (path) => path.replace(/\/+$/, '').replace(/^\.\/?/, '')
  const source = trim(from)
  const destination = trim(to ?? '')
  const refuse = (message) => {
    const error = new Error(message)
    error.report = {
      verb: 'moveNotes',
      ok: false,
      changed: [],
      created: [],
      deleted: [],
      skipped: [],
      unresolved: [],
      notes: [message],
    }
    throw error
  }
  if (to === undefined) refuse(`a folder moves to a folder: awt move ${from} <folder>/`)
  if (destination.endsWith('.md')) refuse(`${from} is a folder, and ${to} names a note`)

  const pairs = workspace.resources
    .map((resource) => resource.path)
    .filter((path) => path.startsWith(`${source}/`))
    .sort()
    .map((path) => {
      const rest = path.slice(source.length + 1)
      return {from: path, to: destination ? `${destination}/${rest}` : rest}
    })
  if (pairs.length === 0) refuse(`no note under ${source}/`)
  return pairs
}

async function runVerb(values, action) {
  // `human` is the one command whose report is not only a list of what changed:
  // `frontmatter` answers with a value. Every other verb leaves it unset and gets
  // the shape they all share.
  const human = values.human ?? reportLines
  try {
    const report = await action()
    emit(values, report, human)
    return report.ok ? 0 : 1
  } catch (error) {
    if (!error.report) throw error
    emit(values, error.report, reportLines)
    return 1
  }
}

/**
 * A `key=value` pair as typed, with the value read as YAML.
 *
 * `status=stable` is a string, `depth=2` a number, `tags=[a, b]` a list — the same
 * reading the note itself would get, which is the one a person typing into a
 * front-matter command expects. Anything YAML cannot parse is taken as the literal
 * string, so a value with a stray colon in it lands as what was typed rather than
 * as a refusal about YAML syntax.
 */
function pair(entry, flag) {
  const at = entry.indexOf('=')
  if (at < 1) {
    const error = new Error(`--${flag} takes key=value, and "${entry}" has no "=".`)
    error.exitCode = 2
    throw error
  }
  return {key: entry.slice(0, at), value: scalar(entry.slice(at + 1))}
}

function scalar(text) {
  try {
    const value = parseYaml(text)
    return value === null && text.trim() !== 'null' && text.trim() !== '~' && text.trim() !== '' ? text : value
  } catch {
    return text
  }
}

/**
 * A front-matter read, for a person: the value as YAML, which is what the note
 * itself says. `--json` hands back the whole report, `frontmatter` and all.
 *
 * A write is rendered by `reportLines` like every other verb's, so the two halves
 * of the one command do not print in two shapes.
 */
function frontmatterLines(report) {
  // `--schema` prints the path and nothing else, so it composes: `cat "$(awt
  // frontmatter x.md --schema)"`. The schema itself is on `--json`, where a
  // program can read it without a second call.
  if ('schemaContent' in report) return report.schema ?? 'no schema claims this path'

  // `--validate` is a question, and its answer is the violations rather than a
  // list of what changed. It has three answers, not two: a note nothing checked is
  // not a note that passed, and saying `valid` about it is how a note outside the
  // vocabulary stays invisible.
  if (report.violations && !('frontmatter' in report) && report.changed?.length === 0) {
    if (!report.schema) return 'unchecked: no schema claims this path'
    if (report.violations.length === 0) return 'valid'
    return ['invalid', ...report.violations.map((one) => `  ${one}`)].join('\n')
  }
  if (!('frontmatter' in report) || report.frontmatter === null) return reportLines(report)
  const value = report.frontmatter
  const text = typeof value === 'string' ? value : stringifyYaml(value).replace(/\n$/, '')
  return report.notes?.length ? [text, ...report.notes.map((note) => `  note: ${note}`)].join('\n') : text
}

/**
 * A segment path as typed, or a refusal that names where it came from.
 *
 * JSON rather than a little selector language: the path is the library's own
 * structure, an agent generates it more often than a person types it, and a
 * dialect invented here would be a second thing to keep in step with the scheme.
 */
function parsePath(text, source) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    const refusal = new Error(`${source} is not JSON: ${error.message}`)
    refusal.exitCode = 2
    throw refusal
  }
  if (!Array.isArray(value)) {
    const refusal = new Error(`${source} is a path, which is an array of segments, and this is ${typeof value}.`)
    refusal.exitCode = 2
    throw refusal
  }
  return value
}

/**
 * A query's answer, for a person.
 *
 * The lines go first on every target, because the reason to read a section here
 * rather than open the file is usually to find out which lines to change.
 */
function queryLines(found) {
  if (!found.ok) {
    return [found.message, found.code ? `  code: ${found.code}` : '', found.candidates?.length ? `  candidates: ${found.candidates.length}` : '']
      .filter(Boolean)
      .join('\n')
  }
  if (found.kind === 'outline') {
    if (!found.outline.length) return 'no headings'
    return found.outline
      .map((entry) => `${String(entry.line).padStart(5)}  ${'  '.repeat(entry.depth - 1)}${'#'.repeat(entry.depth)} ${entry.text}`)
      .join('\n')
  }

  const lines = []
  for (const target of found.targets) {
    const where = target.line ? `${target.line}${target.endLine && target.endLine !== target.line ? `-${target.endLine}` : ''}: ` : ''
    lines.push(`${where}${target.kind}`)
    lines.push(...targetBody(target).map((line) => `  ${line}`))
  }
  for (const disagreement of found.disagreements ?? []) {
    lines.push(
      `  note: segment ${disagreement.segment}'s ${disagreement.type} ${disagreement.field} said ` +
        `${disagreement.expected} and the name is at ${disagreement.actual}; the name won`,
    )
  }
  return lines.join('\n')
}

function targetBody(target) {
  switch (target.kind) {
    case 'table':
      return [target.header.join(' | '), ...target.rows.map((row) => target.header.map((name) => row[name]).join(' | '))]
    case 'row':
      return Object.entries(target.values).map(([name, value]) => `${name}: ${value}`)
    case 'column':
      return target.values
    case 'cell':
      return [target.value]
    case 'heading':
      return [`${'#'.repeat(target.depth)} ${target.text}`]
    case 'list':
      return target.items.flatMap((item) => item.markdown.trimEnd().split('\n'))
    default:
      return (target.markdown ?? target.text ?? '').trimEnd().split('\n')
  }
}

/** One row per note, and the totals under them. */
function measureLines(measured) {
  if (measured.code) return measured.message
  const columns = ['words', 'dates', ...('matches' in (measured.notes[0] ?? {}) ? ['matches'] : [])]
  const lines = measured.notes.map((row) =>
    [...columns.map((name) => String(row[name]).padStart(6)), ` ${row.path}`].join(''),
  )
  if (measured.notes.length !== 1) {
    lines.push([...columns.map((name) => String(measured.totals[name]).padStart(6)), ` (${measured.totals.notes} notes)`].join(''))
  }
  for (const path of measured.missing) lines.push(`  MISSING ${path}: no note and no folder there`)
  return lines.join('\n')
}

/**
 * Write the toolbox index into the site, for a build that is about to run.
 *
 * It is emitted here rather than left to whoever runs the build, because the
 * shadow compares the rendered pages against it: an artifact one edit out of date
 * reports a disagreement that is not real, or an agreement that is not either.
 * Every command that starts a build goes through this, which is what stops the
 * two coming apart — the serve command people used to type by hand did not.
 *
 * Same resolution rule the build uses, so both find the same project from
 * anywhere inside it. Returns an exit code.
 */
async function emitIndexForSite(command, values) {
  const layout = await layoutFor(command, values)
  if (layout === undefined) return {code: 2}
  const wiki = values.wiki ? resolvePath(values.wiki) : layout.notesDir
  const site = values.site ? resolvePath(values.site) : layout.siteDir
  // The first thing written into build/, so it is made here, with the file that ignores it.
  const {INDEX, ensureBuildDir} = await import('@agent-wiki-toolbox/publish')
  ensureBuildDir(site)
  const out = resolvePath(site, INDEX)
  const workspace = writeSiteIndex(wiki, out)
  const summary = indexSummary(workspace, out)
  // Publish and serve emit the index before they run, so this line is a step in
  // someone else's report. Under --json it would be a second document above the
  // first, which is the one thing a --json caller cannot be handed.
  if (!values.json) process.stdout.write(`index: ${summary.notes} notes, ${summary.links} links\n`)
  return {code: 0, ...summary}
}

/**
 * Read the wiki and write its index to `out`, stamped with the moment the read
 * began, so an edit that lands while the tree is being read leaves the index
 * visibly stale rather than looking covered.
 */
function writeSiteIndex(wiki, out) {
  const asOf = new Date()
  const workspace = loadWorkspace(wiki)
  writeIndexArtifact(workspace, out, {asOf})
  return workspace
}

/**
 * What the build needs from awt.config.mjs, as arguments: the `site` declaration
 * as one JSON document, the project directory its relative paths are written
 * against, and the ports. Config discovery belongs to `format`, and `publish`
 * may not reach it, so these are read here and handed over explicitly.
 */
async function siteArgs(layout) {
  const {config} = await loadProjectConfig(layout?.projectDir ?? process.cwd())
  const ports = config.serve ?? {}
  return [
    ...(config.site ? ['--site-config', JSON.stringify(config.site)] : []),
    ...(layout?.projectDir ? ['--project', layout.projectDir] : []),
    ...(ports.port === undefined ? [] : ['--configPort', String(ports.port)]),
    ...(ports.wsPort === undefined ? [] : ['--configWsPort', String(ports.wsPort)]),
  ]
}

/** What was written, the same four numbers whichever command asked for it. */
function indexSummary(workspace, out) {
  return {
    out,
    notes: workspace.resources.length,
    links: workspace.edges.length,
    placeholders: workspace.placeholders().length,
    ambiguous: workspace.ambiguities.length,
  }
}

export const COMMANDS = [
  {
    name: 'fmt',
    writes: true,
    section: 'Format',
    summary: "Format markdown in IntelliJ's style, inside a wiki or on a lone file",
    usage:
      'awt fmt [paths...] [--verbose]\n' +
      '       awt fmt --dry-run [paths...]\n' +
      '       awt fmt --stdin',
    positionals: 'any',
    notes: [
      'With -w, paths are relative to the notes directory. Without it, a path is tried against the',
      'current directory first and the notes directory second; --json reports which as `base`.',
      'With no path, no -w and no `files` in the config, the whole wiki is formatted.',
    ],
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      'dry-run': {type: 'boolean', default: false},
      stdin: {type: 'boolean', default: false},
      verbose: {type: 'boolean', default: false},
    },
    /**
     * One command for both the standalone formatter and the wiki's, so `mdfmt` is
     * not a second binary. `--workspace` picks the wiki reading outright. Without
     * it a path is resolved against the cwd, then against the project's notes
     * directory; the config comes from the files named rather than from the cwd.
     */
    async run({values, positionals}) {
      const checking = values['dry-run']
      let cwd = process.cwd()
      let base = 'cwd'
      if (values.workspace) {
        cwd = await notesDirFor(values)
        base = 'workspace'
      } else if (positionals.length && !positionals.every((entry) => existsSync(resolvePath(cwd, entry)))) {
        const layout = await resolveLayout(cwd, {quiet: true})
        if (layout && positionals.every((entry) => existsSync(resolvePath(layout.notesDir, entry)))) {
          cwd = layout.notesDir
          base = 'notes'
        }
      }

      // A path that is not there is a typo, and it used to travel all the way to
      // remark and come back as `No such file or folder` wrapping node's
      // `ENOENT ... stat '<absolute path>'` — a syscall and a resolved path,
      // neither of which is what the person got wrong. Refused here instead, and
      // the whole call is refused rather than the rest formatted around it.
      //
      // **Only literal paths.** A glob and a directory are both legal inputs that
      // expand to files, and `existsSync` says no to a glob — so checking every
      // positional would refuse `awt fmt 'notes/*.md'`, which works today.
      if (!values.stdin) {
        const missing = positionals.filter(
          (entry) => !/[*?[\]{}]/.test(entry) && !existsSync(resolvePath(cwd, entry)),
        )
        if (missing.length > 0) {
          const error = new Error(
            `no file at ${missing.join(', ')}. Paths are relative to ${base === 'notes' ? 'the notes directory' : 'the current directory'}.`,
          )
          error.exitCode = 2
          throw error
        }
      }

      let config
      let configPath
      try {
        ;({config, filepath: configPath} = await resolveProjectConfig(
          values.workspace ? [] : positionals,
          cwd,
        ))
      } catch (error) {
        if (error.code !== AMBIGUOUS_CONFIG) throw error
        process.stderr.write(`awt fmt: ${error.message}\n`)
        return 2
      }

      // No path, no -w, no `files` in the config: inside a project, that means the
      // notes, as a bare `check` does.
      if (!positionals.length && !values.workspace && !config.files) {
        const layout = await resolveLayout(cwd, {quiet: true})
        if (layout) {
          cwd = layout.notesDir
          base = 'notes'
        }
      }

      if (values.stdin) {
        const {formatMarkdown} = await import('@agent-wiki-toolbox/format')
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        const source = Buffer.concat(chunks).toString('utf8')
        const formatted = formatMarkdown(source, config)
        if (checking) return formatted === source ? 0 : 1
        process.stdout.write(formatted)
        return 0
      }
      // The report is collected rather than streamed so the verdict can go above
      // it, the way `check`'s does. Nothing else on this binary makes you read to
      // the end to find out whether it worked.
      // Under a rootDir layout the schema globs are read from the notes directory
      // (they say `meta/**`, not the layout again); a legacy or bare config keeps
      // its own directory as the base, which is what its globs were written for.
      const layout = configPath ? layoutFrom(config, configPath) : null
      const report = collectStream()
      const result = await runFormat({
        files: positionals,
        config,
        configPath,
        globBase: layout && !layout.legacy ? layout.notesDir : undefined,
        cwd,
        mode: checking ? 'check' : 'format',
        quiet: !values.verbose,
        streamError: report,
      })

      const text = report.text()
      if (values.json) {
        emit(values, {
          ok: result.code === 0,
          mode: checking ? 'check' : 'format',
          files: result.files,
          problems: result.problems,
          paths: positionals.length ? positionals : ['.'],
          base,
          baseDir: cwd,
          config: configPath ?? null,
          report: text.trimEnd() || null,
        })
        return result.code
      }
      if (result.code !== 2) process.stdout.write(`${verdict(result, checking)}\n`)
      if (text) process.stderr.write(text)
      return result.code
    },
  },
  {
    name: 'check',
    section: 'Ask',
    summary: 'Everything wrong with the link graph, in one call. Placeholders are reported separately and do not affect the exit code',
    usage: 'awt check [--quiet]',
    positionals: 0,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, quiet: {type: 'boolean', short: 'q', default: false}},
    /**
     * **The verdict goes first.** It used to be the last line, under a first line
     * of counts that says nothing about health — so `awt check | head -1` printed
     * *"5 notes, 0 links, 0 placeholders, 5 orphans, 5 dead ends"* for a wiki with
     * two errors in it, and the pipeline threw the non-zero exit away on top. A
     * truncated report that reads as a clean one is the failure this command
     * exists to prevent, and truncating it is one keystroke away at all times.
     *
     * `--quiet` prints the problems and nothing else, so silence means healthy and
     * the exit code carries the answer.
     */
    async run({values}) {
      const health = check(loadWorkspace(await notesDirFor(values)))
      emit(values, health, (value) => {
        const problems = value.problems.map(
          (problem) => `  ${problem.severity} ${problem.path}:${problem.line} [${problem.rule}] ${problem.message}`,
        )
        if (values.quiet) return problems.join('\n')

        const verdict = value.healthy ? 'graph is healthy' : `${value.problems.length} problem(s)`
        const counts =
          `${value.notes} notes, ${value.links} links, ${value.placeholders.length} placeholders, ` +
          `${value.orphans.length} orphans, ${value.deadends.length} dead ends`
        return [`${verdict}; ${counts}`, ...problems].join('\n')
      })
      return health.healthy ? 0 : 1
    },
  },
  {
    name: 'search',
    section: 'Ask',
    summary: 'Search note bodies, titles, front matter and tags in one pass',
    usage:
      'awt search <query...> [--tag t] [--type t] [--area a] [--topic t]\n' +
      '             [--fields text,title,tags,properties] [--limit n]',
    positionals: 'any',
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      tag: {type: 'string'},
      type: {type: 'string'},
      area: {type: 'string'},
      topic: {type: 'string'},
      fields: {type: 'string'},
      limit: {type: 'string'},
    },
    /**
     * **The footer is not decoration.** The search caps at 20 by default, the
     * envelope has recorded `total` and `truncated` from the start, and this
     * renderer printed neither — so `awt search the` listed 20 of 73 notes, said
     * nothing, and exited 0. Every `--json` caller could see it and every person
     * and agent reading the text could not, which is the worst way round.
     */
    async run({values, positionals}) {
      const found = search(loadWorkspace(await notesDirFor(values)), {
        query: positionals.join(' ') || undefined,
        tag: values.tag,
        type: values.type,
        area: values.area,
        topic: values.topic,
        fields: values.fields?.split(','),
        limit: values.limit ? Number(values.limit) : undefined,
      })
      emit(values, found, (value) => {
        if (!value.results.length) return 'no matches'
        const lines = value.results.map((entry) =>
          [`${entry.path}`, ...entry.matches.map((m) => `  ${m.line}: ${m.text}`)].join('\n'),
        )
        if (value.truncated) {
          lines.push(`… ${value.total - value.results.length} more not shown; --limit ${value.total} for all of them`)
        }
        return lines.join('\n')
      })
      return found.total > 0 ? 0 : 1
    },
  },
  {
    name: 'connections',
    section: 'Ask',
    summary: 'Links out of and into a note, optionally several hops out',
    usage: 'awt connections <path> [--depth n] [--direction in|out|both]',
    positionals: 1,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, depth: {type: 'string'}, direction: {type: 'string'}},
    async run({values, positionals}) {
      const result = connections(loadWorkspace(await notesDirFor(values)), {
        path: positionals[0],
        depth: values.depth ? Number(values.depth) : undefined,
        direction: values.direction,
      })
      // The miss is reported before anything is read off the hit. Destructuring
      // `links` first turned "no note at conventions" — the sentence that says
      // what went wrong — into a TypeError, on the human surface only: `--json`
      // and the MCP tool were handing back the error all along.
      emit(values, result, (value) =>
        value.error
          ? value.error
          : [
              `${value.path}: ${value.title}`,
              `  links:     ${value.links.map((e) => e.path).join(', ') || 'none'}`,
              `  backlinks: ${value.backlinks.map((e) => e.path).join(', ') || 'none'}`,
            ].join('\n'),
      )
      return result.error ? 1 : 0
    },
  },
  {
    name: 'resolve',
    section: 'Ask',
    summary: 'What a link points at, and what else matched when it is ambiguous',
    usage: 'awt resolve <target> [--from note.md]',
    positionals: 1,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, from: {type: 'string'}},
    async run({values, positionals}) {
      const outcome = resolveLink(loadWorkspace(await notesDirFor(values)), {
        target: positionals[0],
        from: values.from,
      })
      emit(values, outcome, (value) =>
        [
          `${value.target} → ${value.status}${value.path ? ` ${value.path}` : ''}`,
          value.candidates?.length ? `  candidates: ${value.candidates.join(', ')}` : '',
          value.anchor ? `  anchor #${value.anchor.name}: ${value.anchor.status}` : '',
          value.note ? `  ${value.note}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return outcome.status === 'resolved' || outcome.status === 'crossWiki' ? 0 : 1
    },
  },
  {
    name: 'query',
    section: 'Ask',
    summary: "Read inside a note's body by address: a section, a table as rows, a column, a block",
    usage:
      'awt query <note> [--outline]\n' +
      '       awt query <note> --address \'[{"section": "Fields"}, {"table": {}}]\'\n' +
      '       awt query <note> --address -   < address.json',
    positionals: 1,
    notes: [
      'With no --address it prints the outline: every heading, its depth, and the address that reaches it.',
      'Read that first and write the next call off it.',
      '',
      'An address is an array of {type: spec}, each resolving inside what the one before it found:',
      '  section {text, nth} (or a bare heading string)   heading {text, nth}',
      '  table {header, nth}   row {where: {column, eq}, index}   column {header, index}',
      '  cell {row, column}    list {nth}   list_item {term, nth}   block {prefix, nth}',
      'Each segment carries a name and a position and prefers the name; pass both and a disagreement',
      'is reported rather than hidden. An empty spec is every candidate, so a shorter address answers more.',
      '',
      'The address is a coordinate, so it goes on argv; --address - reads it from stdin instead, which',
      'is where an address a program generated belongs.',
      '',
      'Front matter is a separate domain: `awt frontmatter` reads that, and this does not.',
    ],
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, address: {type: 'string'}, outline: {type: 'boolean', default: false}},
    /**
     * **The note is the positional and the address is the flag.** Every command on
     * this binary takes the note it works on as its first argument, and a `query`
     * that took the note on a flag would be the one exception.
     *
     * The flag is `--address`, which is what the verb calls the argument, and not
     * `--path`, which on this binary is a note — `awt listing --path index.md`.
     * One name meaning a file on one command and a segment path on another is a
     * flag a caller gets wrong in the direction that reads as an answer.
     */
    async run({values, positionals}) {
      let path
      if (values.address === '-') {
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        path = parsePath(Buffer.concat(chunks).toString('utf8'), 'stdin')
      } else if (values.address !== undefined) {
        path = parsePath(values.address, '--address')
      }

      const found = query(loadWorkspace(await notesDirFor(values)), {
        note: positionals[0],
        path,
        outline: values.outline,
      })
      emit(values, found, queryLines)
      return found.ok ? 0 : 1
    },
  },
  {
    name: 'measure',
    section: 'Ask',
    summary: 'Words, ISO dates and a pattern\'s hits, per note, in one call',
    usage: 'awt measure [paths...] [--pattern REGEX]',
    positionals: 'any',
    notes: [
      'A path is a note or a folder; a folder measures every note under it, and no path at all',
      'measures the whole wiki.',
      '',
      'Front matter is not counted: it is prose to `wc` and to nothing else, and a note with eight',
      'fields and two sentences measures as a substantial one. --pattern counts hits rather than',
      'lines, which is the other half of what the `wc`/`grep -c` loop this replaces gets wrong.',
      'It is a regex, bare or as /pattern/flags.',
    ],
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, pattern: {type: 'string'}},
    async run({values, positionals}) {
      const measured = measure(loadWorkspace(await notesDirFor(values)), {
        paths: positionals,
        pattern: values.pattern,
      })
      emit(values, measured, measureLines)
      return measured.ok ? 0 : 1
    },
  },
  {
    name: 'move',
    writes: true,
    section: 'Change',
    summary: 'Move or rename notes, rewriting every link into them',
    usage: 'awt move <from> <to>  |  awt move <folder>/ <folder>/  |  awt move --plan <file|->',
    positionals: 2,
    notes: [
      'A destination with no folder in it stays in the source\'s own, so <to> is either a new name',
      'or a new path. There was a separate `rename` for the first of those; move.js calls the two',
      '"the same operation, named for the two intents", so the CLI shows one and the library keeps',
      'both. The MCP surface, which does not nest, keeps rename as its own tool.',
      '',
      'A folder moves every note under it as one plan, and --plan reads one as JSON, an array of',
      '{"from", "to"} pairs, from a file or from stdin as -. A plan is resolved against the layout',
      'it produces, so every link is written once; a destination that is another pair\'s source is',
      'refused, and the folders the moves empty are removed.',
    ],
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      'dry-run': {type: 'boolean', default: false},
      plan: {type: 'string'},
    },
    async run({values, positionals}) {
      const [from, to] = positionals
      const dryRun = values['dry-run']
      if (values.plan !== undefined && positionals.length > 0) {
        usageError('--plan is the whole plan, and takes no <from> <to> beside it.')
      }
      const pairs = values.plan === undefined ? undefined : await readPlan(values.plan)

      return runVerb(values, async () => {
        const notesDir = await notesDirFor(values)
        if (pairs) return moveNotes(notesDir, {pairs, dryRun})
        if (from && isFolder(notesDir, from)) {
          const workspace = loadWorkspace(notesDir)
          return moveNotes(notesDir, {pairs: folderPlan(workspace, from, to), workspace, dryRun})
        }
        return to && !to.includes('/')
          ? renameNote(notesDir, {path: from, name: to, dryRun})
          : moveNote(notesDir, {from, to, dryRun})
      })
    },
  },
  {
    name: 'delete',
    writes: true,
    section: 'Change',
    summary: 'Delete a note. Links into it are reported, not rewritten',
    usage: 'awt delete <path>',
    positionals: 1,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        deleteNote(await notesDirFor(values), {path: positionals[0], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'split',
    writes: true,
    section: 'Change',
    summary: 'Split a note into several, one per heading named in the plan',
    usage:
      'awt split <path> --source delete|stub|keep \\\n' +
      '         --section "Heading=target/path.md" [--section ...]',
    positionals: 1,
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      section: {type: 'string', multiple: true},
      source: {type: 'string'},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values, positionals}) {
      const plan = (values.section ?? []).map((entry) => {
        const at = entry.indexOf('=')
        return {heading: entry.slice(0, at), path: entry.slice(at + 1)}
      })
      return runVerb(values, async () =>
        splitByHeading(await notesDirFor(values), {
          path: positionals[0],
          plan,
          source: values.source,
          dryRun: values['dry-run'],
        }),
      )
    },
  },
  {
    name: 'merge',
    writes: true,
    section: 'Change',
    summary: 'Merge notes into one, each as a section under its own title, repointing every link into them',
    usage: 'awt merge <source...> --into <path> --source delete|keep [--depth n]',
    positionals: 'any',
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      into: {type: 'string'},
      source: {type: 'string'},
      depth: {type: 'string'},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values, positionals}) {
      return runVerb(values, async () =>
        mergeFiles(await notesDirFor(values), {
          sources: positionals,
          into: values.into,
          source: values.source,
          depth: values.depth ? Number(values.depth) : undefined,
          dryRun: values['dry-run'],
        }),
      )
    },
  },
  {
    name: 'rename-tag',
    writes: true,
    section: 'Change',
    summary: 'Rename a front-matter tag everywhere it appears',
    usage: 'awt rename-tag <from> <to>',
    positionals: 2,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        renameTag(await notesDirFor(values), {from: positionals[0], to: positionals[1], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'frontmatter',
    writes: true,
    section: 'Change',
    summary: "Read or write a note's front matter: the whole block, or one key",
    usage:
      'awt frontmatter <path>\n' +
      '       awt frontmatter <path> --validate | --schema\n' +
      '       awt frontmatter <path> --get KEY | --set KEY=VALUE | --unset KEY\n' +
      '       awt frontmatter <path> --rename OLD=NEW | --append KEY=VALUE | --prepend KEY=VALUE\n' +
      '       awt frontmatter <path> --replace-block --derived < block.yaml',
    positionals: 1,
    notes: [
      'With no operation flag it prints the whole block. Exactly one operation per call.',
      'A value is read as YAML, so --set depth=2 is a number and --set tags=[a, b] is a list.',
      '--append and --prepend take a sequence-valued key: tags, sources. A key that is not there is',
      'created holding the one item; a key holding a scalar is refused, because that is a typo.',
      "--unset drops a key. It is not spelled --delete because `awt delete` deletes a note, and one",
      'word meaning two things a command apart is how a flag gets typed at the wrong thing.',
      '--rename moves a key and leaves its value where it is.',
      '',
      'Every write is checked against the schema for that path, and a violation is reported beside the',
      'write rather than refusing it: one write is not the unit a schema applies to, and a migration',
      'passes through states no schema accepts on its way to one it does. --validate asks the same',
      'question on its own and exits non-zero when the note does not satisfy its schema.',
      '',
      '--schema names which schema claims a path and prints it. Ask it before writing a new note,',
      'rather than reading a neighbour and inheriting whatever that one got wrong. The path need not',
      'exist yet. No answer means no schema claims the path, and that is all it means.',
      '--replace-block reserialises the whole block, losing comments, quoting and flow sequences, so',
      'it is for front matter the toolbox owns and --derived is how you say so. It reads the object',
      'from stdin rather than argv, which is where markdown and YAML belong.',
      '',
      'The markdown body is a separate domain and is not reachable from this command.',
    ],
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      validate: {type: 'boolean', default: false},
      schema: {type: 'boolean', default: false},
      get: {type: 'string'},
      set: {type: 'string'},
      unset: {type: 'string'},
      rename: {type: 'string'},
      append: {type: 'string'},
      prepend: {type: 'string'},
      'replace-block': {type: 'boolean', default: false},
      derived: {type: 'boolean', default: false},
      'dry-run': {type: 'boolean', default: false},
    },
    /**
     * One flag per operation, rather than `--operation replace --scope content`.
     * The axes are the library's and the MCP surface's, where a caller is a
     * program; a person types the pair, and `--set status=stable` is the pair.
     */
    async run({values, positionals}) {
      // Two operations in one call is a typo with two plausible readings, and
      // picking either silently is the failure this whole tool exists to remove.
      const operations = ['validate', 'schema', 'get', 'set', 'unset', 'rename', 'append', 'prepend', 'replace-block']
      const asked = operations.filter(
        (flag) => values[flag] !== undefined && values[flag] !== false,
      )
      if (asked.length > 1) {
        const error = new Error(`one operation per call, and this asks for ${asked.map((flag) => `--${flag}`).join(' and ')}.`)
        error.exitCode = 2
        throw error
      }

      const call = {path: positionals[0], dryRun: values['dry-run']}
      const [flag] = asked

      if (flag === 'validate') Object.assign(call, {operation: 'validate', scope: 'block'})
      else if (flag === 'schema') Object.assign(call, {operation: 'schema', scope: 'block'})
      else if (flag === 'get') Object.assign(call, {operation: 'read', scope: 'content', key: values.get})
      else if (flag === 'unset') Object.assign(call, {operation: 'delete', scope: 'content', key: values.unset})
      else if (flag === 'set') Object.assign(call, {operation: 'replace', scope: 'content', ...pair(values.set, 'set')})
      else if (flag === 'append') Object.assign(call, {operation: 'append', scope: 'content', ...pair(values.append, 'append')})
      else if (flag === 'prepend') Object.assign(call, {operation: 'prepend', scope: 'content', ...pair(values.prepend, 'prepend')})
      else if (flag === 'rename') {
        const {key, value} = pair(values.rename, 'rename')
        Object.assign(call, {operation: 'replace', scope: 'marker', key, value: String(value)})
      } else if (flag === 'replace-block') {
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        const text = Buffer.concat(chunks).toString('utf8')
        let block
        try {
          block = parseYaml(text)
        } catch (error) {
          const refusal = new Error(`stdin is not YAML: ${error.message}`)
          refusal.exitCode = 2
          throw refusal
        }
        Object.assign(call, {operation: 'replace', scope: 'block', value: block, derived: values.derived})
      } else Object.assign(call, {operation: 'read', scope: 'block'})

      return runVerb({...values, human: frontmatterLines}, async () =>
        frontmatter(await notesDirFor(values), call),
      )
    },
  },
  {
    name: 'listing',
    writes: true,
    section: 'Change',
    summary: 'Regenerate the notes listing between its markers in the wiki index. Text outside the markers is not touched',
    usage: 'awt listing [--path index.md] [--columns note,about]',
    positionals: 0,
    notes: ['--columns defaults to note,about; topic and area are the other columns.'],
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      path: {type: 'string'},
      columns: {type: 'string'},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values}) {
      return runVerb(values, async () =>
        buildListing(await notesDirFor(values), {
          path: values.path,
          columns: values.columns?.split(','),
          dryRun: values['dry-run'],
        }),
      )
    },
  },
  {
    name: 'setup',
    group: 'site',
    section: 'Publish',
    declines: ['wiki'],
    summary: 'Set up (or re-pin) the Quartz install a site builds from',
    usage: 'awt site setup [--site path] [--force]',
    positionals: 0,
    notes: [
      "Runs from anywhere inside the project: the site is <rootDir>/site, with rootDir from the project's",
      'awt.config.mjs (default wiki/), created if it is not there yet. --site names another one,',
      'resolved against the cwd, and has to exist.',
      '',
      "The config Quartz reads is derived before every build from the install's own default and the",
      "`site` declaration in awt.config.mjs, so a site directory needs nothing in it to start. A tracked",
      'site/quartz.config.yaml, if the project keeps one, replaces that base wholesale.',
    ],
    options: {...OUTPUT_OPTIONS, force: {type: 'boolean', default: false}},
    async run({values}) {
      const {bootstrap} = await import('@agent-wiki-toolbox/publish')
      const layout = values.site ? null : await resolveLayout()
      const site = values.site ?? layout?.siteDir
      if (!site) {
        process.stderr.write(
          'awt site setup: no awt.config.mjs here or in any parent, and no site/quartz.config.yaml either.\n' +
            '  Run this from inside the project, or pass --site.\n',
        )
        return 2
      }
      // The default site directory is made here when it is missing. bootstrap treats a --site it is handed as one
      // the person named, which has to exist, and a project that has never had a site never has one.
      if (!values.site) {
        const {ensureSiteDir} = await import('@agent-wiki-toolbox/publish')
        if (ensureSiteDir(site) && !values.json) process.stdout.write(`created ${site}\n`)
      }
      return bootstrap([
        '--site',
        site,
        ...(values.force ? ['--force'] : []),
        ...(values.json ? ['--json'] : []),
      ])
    },
  },
  {
    name: 'publish',
    group: 'site',
    section: 'Publish',
    summary: 'Build the site into a release, or a handoff copy with --offline. Emits the index first',
    usage:
      'awt site publish [--library name | --base url] [--mount name] [--name name] [--target name]\n' +
      '                 [--out path] [--watch] [--offline] [--diagrams png|none]\n' +
      '                 [--nginx] [--skip-index] [--if-stale]',
    positionals: 0,
    notes: [
      'Builds without --serve, so cross-wiki links resolve to published URLs, into a staging',
      'directory, then renames it into place. A failed build leaves the standing release untouched.',
      'The published site it replaces is kept as a hidden -prev beside it; a rollback is a rename.',
      '',
      'The release is built for one address. Usually that is a library\'s: --library names one of',
      '~/.config/awt/libraries/<name>.yaml, else $AWT_LIBRARY, site.target or the machine\'s',
      'default-library in awt.yaml, and the wiki is served at <base>/<collection path>/<name>/ as the',
      'library lists it; a wiki the library does not hold is refused (awt site register). --target is',
      'the old name of --library. --base, --mount and --name give an address outright instead, and',
      'site.baseUrl, site.mount and site.self in awt.config.mjs are the project\'s own standing one. A',
      'base may carry a scheme and a path (http://localhost:8088/wikis); with no scheme it is https.',
      'Each base is built into build/published/<base>, so two built from one checkout do not overwrite',
      'each other. The published site records its address in static/awtRelease.json for `awt site verify`.',
      '',
      'When the library deploys to a directory on this machine, the release is copied into its tree',
      'after it is swapped in, every rebuild under --watch included: see awt site deploy. One deployed',
      'over ssh gets the release only from a one-shot publish that names it with --library, never from',
      '--watch or --if-stale.',
      '',
      '--watch keeps the build running, for editing a wiki whose release is being read: each save is',
      'rebuilt in about half a second and swapped into the release, which is the same release a',
      'one-shot publish makes, for the same target. A failed rebuild leaves the last release in place.',
      'It writes no dev links and starts no server; put a static server in front of the release.',
      'It runs until stopped, and keeps the published site that stood before it as a hidden -prev beside it.',
      '',
      '--offline builds a handoff copy into build/handoff instead: browser-only plugins off, every',
      'link rewritten to a .html file, every script removed. It opens from index.html with no server.',
      '',
      'Mermaid diagrams are pre-rendered to PNG for --offline; --diagrams none leaves them as source',
      'text. A served site draws them in the browser.',
      '',
      '--nginx prints a server block for the release and exits without building.',
      '',
      '--if-stale builds only when a note is newer than the moment the standing release began building,',
      'and never makes a first release: with none for this target it does nothing, so a wiki is published',
      'once by hand and kept current after that. It takes a lock in build/, so two triggers do not build',
      'into one release, and skips when another publish holds it. Exit 0 whether it built or not; made for',
      'a hook that runs at the end of every turn.',
    ],
    options: {
      ...OUTPUT_OPTIONS,
      ...TARGET_OPTIONS,
      out: {type: 'string'},
      offline: {type: 'boolean', default: false},
      watch: {type: 'boolean', default: false},
      diagrams: {type: 'string'},
      nginx: {type: 'boolean', default: false},
      'skip-index': {type: 'boolean', default: false},
      'if-stale': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {publish, INDEX} = await import('@agent-wiki-toolbox/publish')
      const library = libraryFlag('publish', values)
      if (library === null) return 2

      // With --if-stale the index is emitted only once the build is known to be needed, so a skipped
      // run writes nothing: publish asks for it through beforeBuild.
      const emitFirst = async () => {
        const {code} = await emitIndexForSite('publish', values)
        return code
      }
      if (!values.nginx && !values['skip-index'] && !values['if-stale']) {
        const code = await emitFirst()
        if (code !== 0) return code
      }

      // Both paths always handed over, resolved here: `publish` may not reach
      // `format`, which owns the layout, so its own walk is the legacy one.
      const layout = await layoutFor('publish', values)
      if (layout === undefined) return 2

      // Kept current for as long as the build runs, --skip-index or not, as `serve` does: that flag
      // skips the emit before the start, and the first edit would make any index stale all the same.
      const wiki = values.wiki ? resolvePath(values.wiki) : layout.notesDir
      const indexFile = resolvePath(values.site ? resolvePath(values.site) : layout.siteDir, INDEX)
      const reindex = () => {
        const {resources} = writeSiteIndex(wiki, indexFile)
        process.stdout.write(`index: re-emitted, ${resources.length} notes\n`)
      }

      return publish([
        '--wiki',
        values.wiki ?? layout.notesDir,
        '--site',
        values.site ?? layout.siteDir,
        ...(values.out ? ['--out', values.out] : []),
        ...(values.base ? ['--base', values.base] : []),
        ...(values.mount ? ['--mount', values.mount] : []),
        ...(values.name ? ['--name', values.name] : []),
        ...(library ? ['--target', library] : []),
        ...(values.offline ? ['--offline'] : []),
        ...(values.watch ? ['--watch'] : []),
        ...(values.diagrams ? ['--diagrams', values.diagrams] : []),
        ...(values.nginx ? ['--nginx'] : []),
        ...(values.json ? ['--json'] : []),
        ...(values['if-stale'] ? ['--if-stale'] : []),
        ...(await siteArgs(layout)),
      ], {
        reindex,
        beforeBuild: async () => {
          if (values['skip-index']) return
          const code = await emitFirst()
          if (code !== 0) process.exit(code)
        },
      })
    },
  },
  {
    name: 'verify',
    group: 'site',
    section: 'Publish',
    summary: 'Check that a release carries the address its project says it is built for',
    usage: 'awt site verify [--library name | --base url] [--mount name] [--name name] [--target name] [--out path]',
    positionals: 0,
    notes: [
      'Reads static/awtRelease.json from the published site, build/published/<base> or the one a flag names, and',
      'compares its address with the target the flags and awt.config.mjs describe. Builds nothing.',
      'Exits 0 when they match, 1 when they differ or the release carries no record.',
    ],
    options: {
      ...OUTPUT_OPTIONS,
      ...TARGET_OPTIONS,
      out: {type: 'string'},
    },
    async run({values}) {
      const {verifyRelease} = await import('@agent-wiki-toolbox/publish')
      const library = libraryFlag('verify', values)
      if (library === null) return 2
      const layout = await layoutFor('verify', values)
      if (layout === undefined) return 2
      return verifyRelease([
        '--site',
        values.site ?? layout.siteDir,
        ...(values.out ? ['--out', values.out] : []),
        ...(values.base ? ['--base', values.base] : []),
        ...(values.mount ? ['--mount', values.mount] : []),
        ...(values.name ? ['--name', values.name] : []),
        ...(library ? ['--target', library] : []),
        ...(values.json ? ['--json'] : []),
        ...(await siteArgs(layout)),
      ])
    },
  },
  {
    name: 'register',
    group: 'site',
    section: 'Publish',
    writes: true,
    summary: 'Put this wiki in a collection of a library, so it is published and other wikis\' links to it resolve',
    usage: 'awt site register [--library name] [--collection key] [--key name] [--name name] [--dev] [--force] [--dry-run]',
    positionals: 0,
    notes: [
      "Writes this wiki's entry into ~/.config/awt/libraries/<library>.yaml, under the collection's",
      'wikis: the site directory its releases are under, its name when that is not the key, and the',
      'address of its running serve with --dev, which needs serve.port. In a library that deploys over',
      'ssh it also writes repo and path, read from the git remote, when the remote is a hosted one: what',
      'a pipeline would clone. The library is --library, else the default-library in awt.yaml.',
      '',
      'The key is the link key other wikis write before the colon, site.self unless --key says',
      'otherwise. The collection has to exist in the library, with its path and title: those are the',
      "library's to choose. A wiki already in the library keeps its collection when --collection is not",
      'given. The file keeps its comments and its block style.',
      '',
      'Registering what is already registered changes nothing. A different entry under the same key is',
      'replaced only with --force, and a wiki in another collection of the library is refused, since',
      'moving it changes its address: unregister it first.',
    ],
    options: {
      ...OUTPUT_OPTIONS,
      library: {type: 'string'},
      collection: {type: 'string'},
      key: {type: 'string'},
      name: {type: 'string'},
      dev: {type: 'boolean', default: false},
      force: {type: 'boolean', default: false},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {registerWiki, loadMachine, configDir} = await import('@agent-wiki-toolbox/publish')
      const {spawnSync} = await import('node:child_process')
      const path = await import('node:path')
      const layout = await layoutFor('register', values)
      if (layout === undefined || layout === null) return 2
      const projectDir = layout.projectDir ?? process.cwd()
      const {config} = await loadProjectConfig(projectDir)
      const site = config.site ?? {}
      const port = config.serve?.port
      if (values.dev && port === undefined) {
        process.stderr.write('awt site register: --dev records the address of this wiki\'s serve, and serve.port is not set in awt.config.mjs.\n')
        return 2
      }
      try {
        const machine = loadMachine({})
        const library = values.library ?? machine.defaultTarget
        if (!library) {
          process.stderr.write('awt site register: no library: pass --library or set default-library in awt.yaml.\n')
          return 2
        }
        const key = values.key ?? site.self ?? basename(projectDir).toLowerCase()
        const lib = machine.targets.get(library)
        const collection = values.collection ?? lib?.members.get(key)?.collection
        if (lib && !collection) {
          process.stderr.write(`awt site register: pass --collection; ${library} has ${lib.collections.map((c) => c.key).join(', ') || 'no collections'}.\n`)
          return 2
        }

        // What a pipeline would clone: only a hosted remote, since a path on this machine or another is no address elsewhere.
        let source = {}
        if (lib?.deploy?.remote) {
          const git = (...args) => spawnSync('git', ['-C', projectDir, ...args], {encoding: 'utf8'})
          const remote = git('remote', 'get-url', 'origin').stdout?.trim()
          const top = git('rev-parse', '--show-toplevel').stdout?.trim()
          if (remote && top && /^(git@|https?:\/\/|ssh:\/\/)/.test(remote)) {
            source = {repo: remote, path: path.relative(top, path.dirname(layout.siteDir)) || '.'}
          }
        }
        const entry = {
          ...(values.name ? {name: values.name} : {}),
          site: layout.siteDir,
          ...(values.dev ? {dev: `http://localhost:${port}`} : {}),
          ...source,
        }
        const result = registerWiki({library, collection, key, entry, force: values.force, dryRun: values['dry-run']})
        emit(values, {ok: true, key, library, collection, ...result, dir: configDir()}, (value) =>
          value.changed
            ? `${value.dryRun ? 'would register' : 'registered'} ${key} in ${library}, collection ${collection}\n  ${value.file}`
            : `${key} is already in ${library}, collection ${collection}, unchanged`,
        )
        return 0
      } catch (error) {
        process.stderr.write(`awt site register: ${error.message}\n`)
        return 1
      }
    },
  },
  {
    name: 'unregister',
    group: 'site',
    section: 'Publish',
    writes: true,
    declines: ['wiki', 'site'],
    summary: 'Take a wiki out of a library',
    usage: 'awt site unregister <key> [--library name] [--dry-run]',
    positionals: 1,
    notes: ['Removes the entry from its collection in the library file, else the default library. Its copy in the tree stays until the tree is rebuilt.'],
    options: {...OUTPUT_OPTIONS, library: {type: 'string'}, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      const {unregisterWiki, readDefaultTarget} = await import('@agent-wiki-toolbox/publish')
      try {
        const library = values.library ?? readDefaultTarget()
        if (!library) {
          process.stderr.write('awt site unregister: no library: pass --library or set default-library in awt.yaml.\n')
          return 2
        }
        const result = unregisterWiki({library, key: positionals[0], dryRun: values['dry-run']})
        emit(values, {ok: true, key: positionals[0], library, ...result}, (value) =>
          `${value.dryRun ? 'would remove' : 'removed'} ${value.key} from ${library}, collection ${value.collection}\n  ${value.file}`,
        )
        return 0
      } catch (error) {
        process.stderr.write(`awt site unregister: ${error.message}\n`)
        return 1
      }
    },
  },
  {
    name: 'wikis',
    group: 'site',
    section: 'Publish',
    declines: ['wiki', 'site'],
    summary: "The machine's libraries, their collections, and each wiki's address in each library",
    usage: 'awt site wikis [--key name]',
    positionals: 0,
    notes: [
      'Reads ~/.config/awt (or $AWT_CONFIG_DIR): awt.yaml and libraries/*.yaml.',
      'The wiki-level settings in a project\'s awt.config.mjs are not shown: this is the machine.',
    ],
    options: {...OUTPUT_OPTIONS, key: {type: 'string'}},
    async run({values}) {
      const {loadMachine, describeMachine, configDir} = await import('@agent-wiki-toolbox/publish')
      try {
        const dir = configDir()
        const view = describeMachine(loadMachine({dir}), values.key ?? null)
        if (values.key && view.wikis.length === 0) {
          process.stderr.write(`awt site wikis: no wiki "${values.key}" in ${dir}.\n`)
          return 1
        }
        emit(values, view, (value) => {
          const lines = [`config: ${value.dir}`]
          lines.push(value.targets.length ? 'libraries:' : 'libraries: none (libraries/*.yaml)')
          for (const t of value.targets) {
            lines.push(`  ${t.name.padEnd(10)}${t.base}${t.default ? '  (default)' : ''}${t.deploy ? `  -> ${t.deploy}` : ''}`)
            if (!values.key) for (const c of t.collections) lines.push(`    ${c.path.padEnd(18)}${c.title}  (${c.wikis.length})`)
          }
          lines.push(value.wikis.length ? 'wikis:' : 'wikis: none registered')
          for (const w of value.wikis) {
            lines.push(`  ${w.key}${w.site ? `  ${w.site}` : ''}${w.dev ? `  dev ${w.dev}` : ''}`)
            for (const [target, url] of Object.entries(w.addresses)) if (url) lines.push(`    ${target.padEnd(8)}${url}`)
          }
          return lines.join('\n')
        })
        return 0
      } catch (error) {
        process.stderr.write(`awt site wikis: ${error.message}\n`)
        return 1
      }
    },
  },
  {
    name: 'deploy',
    group: 'site',
    section: 'Publish',
    writes: true,
    declines: ['wiki', 'site'],
    summary: "Copy a library's releases into its tree, with its pages and nginx config",
    usage: 'awt site deploy [--library name] [--key name] [--dry-run]',
    positionals: 0,
    notes: [
      "A library's deploy.to is a directory, or host:path over ssh, holding library/, the tree laid out",
      "as the library's URLs, and conf.d/, the nginx config. Deploy writes the landing page, a page per",
      "collection and the config, then copies each wiki's release from build/published/<base>/ in its",
      'checkout with rsync --delay-updates --delete. A wiki with no release for the library, or no site',
      'on this machine, is listed and skipped. --key copies one wiki\'s release and nothing else.',
      '',
      'A server mounts the two at /srv/library/ and /etc/nginx/conf.d/, and an htpasswd file named in',
      'access.basic at /etc/nginx/htpasswd/<name>. awt site host is that server for a local library.',
      'A publish for a library that deploys to a directory here copies its release in by itself; one',
      'that names a library deployed over ssh with --library copies its release there.',
    ],
    options: {...OUTPUT_OPTIONS, library: {type: 'string'}, key: {type: 'string'}, 'dry-run': {type: 'boolean', default: false}},
    async run({values}) {
      const {loadMachine, planDeploy, runDeploy} = await import('@agent-wiki-toolbox/publish')
      try {
        const machine = loadMachine({})
        const name = values.library ?? process.env.AWT_LIBRARY ?? machine.defaultTarget
        if (!name) {
          process.stderr.write('awt site deploy: no library: pass --library or set default-library in awt.yaml.\n')
          return 2
        }
        const plan = planDeploy({machine, libraryName: name, only: values.key ?? null})
        if (values.key && plan.wikis.length === 0) {
          process.stderr.write(`awt site deploy: the library ${name} has no wiki "${values.key}".\n`)
          return 1
        }
        const steps = runDeploy(plan, {pages: !values.key, dryRun: values['dry-run']})
        emit(values, {ok: true, library: name, to: plan.to.spec, dryRun: values['dry-run'], wikis: plan.wikis, steps}, () => {
          const lines = [`library ${name}  ${plan.base}  ->  ${plan.to.spec}${values['dry-run'] ? '  (dry run)' : ''}`]
          const width = Math.max(0, ...plan.wikis.map((w) => w.path.length)) + 2
          for (const w of plan.wikis) {
            const step = steps.find((s) => s.key === w.key)
            lines.push(`  ${w.path.padEnd(width)}${w.state === 'ready' ? `${values['dry-run'] ? 'would copy' : 'copied'}${step?.ms !== undefined && !values['dry-run'] ? ` in ${step.ms} ms` : ''}` : `skipped   ${w.reason}`}`)
          }
          return lines.join('\n')
        })
        return 0
      } catch (error) {
        process.stderr.write(`awt site deploy: ${error.message}\n`)
        return 1
      }
    },
  },
  {
    name: 'host',
    group: 'site',
    section: 'Publish',
    writes: true,
    declines: ['wiki', 'site'],
    summary: "Deploy a local library and serve its tree with nginx in Docker",
    usage: 'awt site host [--library name] [--target name] [--port N] [--up | --down] [--dry-run]',
    positionals: 0,
    notes: [
      'Runs awt site deploy for the library, which has to deploy to a directory on this machine, then',
      "serves its tree the way any server would: nginx:alpine mounting <to>/library at /srv/library and",
      "<to>/conf.d at /etc/nginx/conf.d. Without --up that is all, and the docker command is printed.",
      '--up runs it in a container named awt-host-<library>, replacing one that awt started and',
      "refusing to touch any other, bound to 127.0.0.1 on the base's port, then asks the server what it",
      'serves. --down removes the container.',
      '',
      'A publish copies its release into the tree, so a wiki published after this ran needs nothing',
      'done. A library whose collections changed needs this, or awt site deploy, run again. Docker has',
      'to be able to read the tree: on macOS it shares /Users. The library is --library, $AWT_LIBRARY or',
      'the default-library; --target is its old name.',
    ],
    options: {
      ...OUTPUT_OPTIONS,
      library: {type: 'string'},
      target: {type: 'string'},
      port: {type: 'string'},
      up: {type: 'boolean', default: false},
      down: {type: 'boolean', default: false},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {loadMachine, planDeploy, runDeploy, planHost, up, down, probe} = await import('@agent-wiki-toolbox/publish')
      if (values.up && values.down) {
        process.stderr.write('awt site host: --up and --down are opposites; pass one.\n')
        return 2
      }
      if (values.port !== undefined && !/^\d+$/.test(values.port)) {
        process.stderr.write(`awt site host: --port takes a number, not ${values.port}.\n`)
        return 2
      }
      const flag = libraryFlag('host', values)
      if (flag === null) return 2
      try {
        const machine = loadMachine({})
        const name = flag ?? process.env.AWT_LIBRARY ?? process.env.AWT_TARGET ?? machine.defaultTarget
        if (!name) {
          process.stderr.write('awt site host: no library: pass --library or set default-library in awt.yaml.\n')
          return 2
        }
        if (values.down) {
          const result = down(name)
          emit(values, {ok: true, ...result}, (v) => (v.removed ? `removed the container ${v.name}` : `no container ${v.name} to remove`))
          return 0
        }

        const deploy = planDeploy({machine, libraryName: name})
        const plan = planHost({machine, targetName: name, deploy, port: values.port})
        if (values.up && !plan.local) {
          process.stderr.write(`awt site host: --up runs a server on this machine, and the base of "${name}" is ${plan.base}, which is not local.\n`)
          return 2
        }
        const steps = runDeploy(deploy, {dryRun: values['dry-run']})
        let served = null
        if (values.up && !values['dry-run']) {
          up(plan)
          served = await probe(plan)
        }

        const failed = served && (served.landing !== 200 || served.wikis.some((w) => !w.serving && w.note.includes('does not see')))
        emit(values, {ok: !failed, library: name, base: plan.base, port: plan.port, dir: plan.dir, dryRun: values['dry-run'], steps, wikis: plan.wikis, docker: plan.docker, served}, () => {
          const lines = [`library ${name}  ${plan.base}  (port ${plan.port})`, `tree    ${plan.dir}`]
          lines.push(plan.wikis.length ? 'wikis:' : 'wikis: none registered (awt site register)')
          const width = Math.max(0, ...plan.wikis.map((w) => w.path.length)) + 2
          for (const w of plan.wikis) {
            const answer = served?.wikis.find((x) => x.key === w.key)
            lines.push(`  ${w.path.padEnd(width)}${answer ? answer.note : w.state === 'ready' ? (values['dry-run'] ? 'would copy' : 'copied') : `skipped   ${w.reason}`}`)
          }
          if (served) lines.push(served.landing === 200 ? `\nserving at http://localhost:${plan.port}${new URL(plan.base).pathname.replace(/\/+$/, '')}/` : `\nthe server answered ${served.landing || 'nothing'} for the landing page`)
          else if (!values['dry-run']) lines.push(`\nto serve it: awt site host --library ${name} --up\n  or: docker ${plan.docker.args.join(' ')}`)
          return lines.join('\n')
        })
        return failed ? 1 : 0
      } catch (error) {
        process.stderr.write(`awt site host: ${error.message}\n`)
        return 1
      }
    },
  },
  {
    name: 'clean',
    group: 'site',
    section: 'Publish',
    writes: true,
    declines: ['wiki'],
    summary: 'Remove what awt generated for the site: build/, or with --legacy the loose files from before it',
    usage: 'awt site clean [--legacy] [--dry-run]',
    positionals: 0,
    notes: [
      "Everything awt generates for a site is in <site>/build/: the link index, the derived Quartz config, the",
      'dev build, published sites and handoff copies. This removes that directory, and all of it can be built',
      'again. A published site that a server is serving goes with it, until it is published again.',
      '',
      '--legacy removes only what awt used to scatter beside package.json before there was a build/:',
      '.awt-index.json, .quartz.config.yaml, .quartz.offline.yaml, public/, release/, releases/, handoff/ and',
      'the hidden staging directories. Nothing else in the directory is touched. node_modules/ is Quartz\'s',
      'install and is not removed by either.',
    ],
    options: {
      ...OUTPUT_OPTIONS,
      legacy: {type: 'boolean', default: false},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {cleanBuild, legacyPresent, removeLegacy, BUILD} = await import('@agent-wiki-toolbox/publish')
      const layout = await layoutFor('clean', values)
      if (layout === undefined || layout === null) return 2
      const site = values.site ? resolvePath(values.site) : layout.siteDir
      const dry = values['dry-run']

      let removed
      if (values.legacy) {
        removed = dry ? legacyPresent(site) : removeLegacy(site)
      } else {
        const had = existsSync(resolvePath(site, BUILD))
        removed = had ? [`${BUILD}/`] : []
        if (had && !dry) cleanBuild(site)
      }
      emit(values, {ok: true, site, dryRun: dry, legacy: values.legacy, removed}, (value) =>
        value.removed.length
          ? `${dry ? 'would remove' : 'removed'} from ${value.site}: ${value.removed.join(', ')}`
          : `nothing to remove in ${value.site}${values.legacy ? ' from before build/' : ''}`,
      )
      return 0
    },
  },
  {
    name: 'serve',
    server: true,
    group: 'site',
    section: 'Publish',
    summary: "Emit the index and run Quartz's dev server over the wiki. Ports come from awt.config.mjs",
    usage: 'awt site serve [--out path] [--port N] [--ws-port N] [--skip-index]',
    positionals: 0,
    notes: [
      "Emits the link-graph index, then runs Quartz's dev server over the wiki, and re-emits the",
      'index after every change to the wiki while it serves. The awt plugin compares the rendered',
      'pages against that index, and waits for a re-emit rather than failing on a stale one.',
      '',
      "Ports come from `serve` in the project's awt.config.mjs, and what the site says about",
      'itself from `site` in the same file:',
      '',
      '    export default {',
      '      serve: {port: 8101},',
      "      site: {title: 'DIOS wiki', self: 'shelton-dios', registry: {…}, properties: [...]},",
      '    }',
      '',
      '--ws-port defaults to the port plus 100. Runs from anywhere inside the project.',
      'The config key stays `serve: {wsPort}` — that is a JS object, where camelCase is right.',
      "The Quartz config itself is derived from that before every build; `awt site migrate` lifts",
      'a tracked quartz.config.yaml into the declaration.',
    ],
    options: {
      out: {type: 'string'},
      port: {type: 'string'},
      'ws-port': {type: 'string'},
      'skip-index': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {serve, INDEX} = await import('@agent-wiki-toolbox/publish')

      if (!values['skip-index']) {
        const {code} = await emitIndexForSite('serve', values)
        if (code !== 0) return code
      }

      // Config discovery belongs to `format`, and `publish` may not reach it — so
      // the layout and the ports are read here, where both are in scope, and
      // handed over as explicit paths. The config is the project's, found by
      // walking up, so `awt site serve` finds the same project the build does no
      // matter where in it you are standing.
      const layout = await layoutFor('serve', values)
      if (layout === undefined) return 2

      // Kept current for as long as the server runs, --skip-index or not: that
      // flag skips the emit before the start, and the first edit would make any
      // index stale all the same.
      const wiki = values.wiki ? resolvePath(values.wiki) : layout.notesDir
      const out = resolvePath(values.site ? resolvePath(values.site) : layout.siteDir, INDEX)
      const reindex = () => {
        const {resources} = writeSiteIndex(wiki, out)
        process.stdout.write(`index: re-emitted, ${resources.length} notes\n`)
      }

      return serve([
        '--wiki',
        values.wiki ?? layout.notesDir,
        '--site',
        values.site ?? layout.siteDir,
        ...(values.out ? ['--out', values.out] : []),
        ...(values.port ? ['--port', values.port] : []),
        ...(values['ws-port'] ? ['--ws-port', values['ws-port']] : []),
        ...(await siteArgs(layout)),
      ], {reindex})
    },
  },
  {
    name: 'proxy',
    server: true,
    writes: true,
    group: 'site',
    section: 'Publish',
    declines: ['wiki', 'site'],
    summary: 'Serve several wikis behind one port, each at /<prefix>/, starting and stopping them itself',
    usage: 'awt site proxy [--config file.json] [--port N] [--install | --uninstall]',
    positionals: 0,
    notes: [
      "Reads the wikis from a config, then answers on one port whatever happens to them: a list of",
      'the wikis at /, and a page saying why for one that is starting, has exited or is not listed.',
      "A wiki's `awt site serve` starts on the first request for it, on ports the proxy picks, and",
      'stops after idleMinutes without one. The config is the one argument; its default is',
      '~/.config/awt/proxy.json (%APPDATA%\\awt\\proxy.json on Windows):',
      '',
      '    {',
      '      "port": 8090,',
      '      "idleMinutes": 30,',
      '      "wikis": {',
      '        "aisandbox": {"project": "~/Dev/AiSandbox", "title": "AiSandbox wiki"}',
      '      }',
      '    }',
      '',
      'A relative project resolves against the config file. One config is one proxy: run two on',
      'two ports for two sets of wikis.',
      '',
      '--install makes it a user service that starts at login and restarts if it exits: a launchd',
      'agent on macOS, a systemd user unit on Linux, a logon task on Windows. It runs this awt,',
      'with the PATH of the shell that installed it. --uninstall removes it.',
    ],
    options: {
      config: {type: 'string'},
      port: {type: 'string'},
      install: {type: 'boolean', default: false},
      uninstall: {type: 'boolean', default: false},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {proxy, defaultConfigFile, readProxyConfig, serviceFor, installService, uninstallService} =
        await import('@agent-wiki-toolbox/publish')
      // This awt, by path, under the runtime running it now: a service has no PATH to
      // find `awt` on, and on Windows `awt` is a shim a plain spawn cannot run.
      const command = [process.execPath, fileURLToPath(new URL('../bin/awt.mjs', import.meta.url))]

      if (values.install && values.uninstall) {
        process.stderr.write('awt site proxy: --install and --uninstall together do not mean anything\n')
        return 2
      }
      if (!values.install && !values.uninstall) {
        if (values['dry-run']) {
          process.stderr.write('awt site proxy: --dry-run goes with --install or --uninstall\n')
          return 2
        }
        return proxy([...(values.config ? ['--config', values.config] : []), ...(values.port ? ['--port', values.port] : [])], {command})
      }
      if (values.port) {
        process.stderr.write('awt site proxy: the port of an installed proxy is the one in its config\n')
        return 2
      }

      const configFile = resolvePath(values.config ?? defaultConfigFile())
      if (values.install) {
        try {
          readProxyConfig(configFile)
        } catch (error) {
          process.stderr.write(`${error.message}\n`)
          return 1
        }
      }
      let service
      try {
        service = serviceFor({platform: process.platform, configFile, command})
      } catch (error) {
        process.stderr.write(`awt site proxy: ${error.message}\n`)
        return 1
      }
      const act = values.install ? installService : uninstallService
      return act(service, {dryRun: values['dry-run']}) ? 0 : 1
    },
  },
  {
    name: 'index',
    group: 'site',
    section: 'Publish',
    summary: 'Write the link-graph index the Quartz plugins read, into the site or to --out',
    usage: 'awt site index [--out path.json]',
    positionals: 0,
    notes: [
      'With no --out it writes <site>/build/awt-index.json, which is where the build looks and what',
      'publish and serve emit before they run. It is grouped here because that file is read by the',
      "toolbox's Quartz plugin and by nothing else — it is not the graph offered as data.",
      '',
      '--out names another file and needs no site, for looking at the graph directly.',
    ],
    options: {...OUTPUT_OPTIONS, out: {type: 'string'}},
    async run({values}) {
      if (!values.out) {
        const {code, ...summary} = await emitIndexForSite('site index', values)
        if (code === 0 && values.json) emit(values, {ok: true, ...summary})
        return code
      }
      // --out asks for the graph as a file, which no site has to exist for.
      const layout = await resolveLayout()
      const root = values.wiki ? resolvePath(values.wiki) : (layout?.notesDir ?? process.cwd())
      const workspace = loadWorkspace(root)
      const out = resolvePath(values.out)
      // mkdir's own ENOENT names the parent and not the flag that chose it, and
      // an --out whose directory is not there is a typo rather than a request to
      // build a tree.
      if (!existsSync(dirname(out))) {
        const error = new Error(`--out names ${out}, and ${dirname(out)} is not there.`)
        error.exitCode = 2
        throw error
      }
      writeIndexArtifact(workspace, out)
      const summary = indexSummary(workspace, out)
      emit(values, {ok: true, ...summary}, (value) =>
        `${values.out}: ${value.notes} notes, ${value.links} links, ` +
          `${value.placeholders} placeholders, ${value.ambiguous} ambiguous`,
      )
      return 0
    },
  },
  {
    name: 'mcp',
    server: true,
    section: 'Agents',
    summary: 'Run the MCP server over stdio, for an agent to talk to',
    usage: 'awt mcp [--allow-writes] [--name n]',
    positionals: 0,
    notes: [
      "With no -w the notes are the project's rootDir/notes, rootDir defaulting to wiki/, so an",
      '.mcp.json entry is `awt mcp --allow-writes` with no path. Without --allow-writes the server',
      'serves the read tools and fmt with dryRun only.',
    ],
    options: {...WORKSPACE_OPTION, 'allow-writes': {type: 'boolean', default: false}, name: {type: 'string'}},
    async run({values}) {
      const {createServer, projectTarget} = await import('@agent-wiki-toolbox/mcp')
      const {StdioServerTransport} = await import('@modelcontextprotocol/sdk/server/stdio.js')
      // The same refusal every other command gets: a server started over a path
      // that is not a directory would otherwise fail on its first tool call,
      // where the agent reads it as the wiki being broken.
      const named = values.workspace ?? process.env.AWT_WORKSPACE
      const explicit = named ? namedWorkspace(named, values.workspace ? '-w' : '$AWT_WORKSPACE') : null
      const server = createServer({
        ...(explicit ? {notesDir: explicit} : {resolveTarget: () => projectTarget()}),
        allowWrites: values['allow-writes'],
        name: values.name,
      })
      await server.connect(new StdioServerTransport())
      return null // stays up until the transport closes
    },
  },
  {
    name: 'migrate',
    group: 'site',
    section: 'Publish',
    writes: true,
    declines: ['wiki'],
    summary: "Lift a tracked site/quartz.config.yaml into awt.config.mjs, or with --machine the old machine config into libraries",
    usage: 'awt site migrate [--machine] [--dry-run]',
    positionals: 0,
    notes: [
      'For a project from before the toolbox derived the Quartz config. Reads the tracked file, pulls',
      "out what was the project's own — title, base URL, prefix and registry, properties, footer — and",
      "writes it as `site: {…}` into awt.config.mjs, when that file has one `export default {` and no",
      '`site` key yet; otherwise it prints the block to paste. Then says what to delete and ignore.',
      '',
      'Anything else the file changed from Quartz\'s default is not carried; the report names the file',
      'so it can be diffed before it goes. --dry-run prints the block and changes nothing.',
      '',
      '--machine lifts ~/.config/awt from before libraries instead: targets.yaml, default-target, groups,',
      'registry.d and overrides.d become awt.yaml and libraries/<target>.yaml, one library per target',
      'with every registered wiki in it, a collection per group in the order of groups, and a local',
      'target deploying to ~/.local/share/awt/libraries/<target>/. The old files move to legacy/. A wiki',
      'with an address of its own (urls) is reported and left out. --dry-run prints the files.',
    ],
    options: {...OUTPUT_OPTIONS, machine: {type: 'boolean', default: false}, 'dry-run': {type: 'boolean', default: false}},
    async run({values}) {
      if (values.machine) {
        const {migrateMachine} = await import('@agent-wiki-toolbox/publish')
        try {
          const result = await migrateMachine({dryRun: values['dry-run']})
          emit(values, {ok: true, ...result}, (v) => {
            const lines = []
            for (const [rel, text] of Object.entries(v.files)) lines.push(v.dryRun ? `--- ${rel}\n${text}` : `wrote ${rel}`)
            lines.push(`${v.dryRun ? 'would move' : 'moved'} to legacy/: ${v.moved.join(', ')}`)
            for (const s of v.skipped) lines.push(`left out ${s.key}: ${s.reason}`)
            return `config: ${v.dir}\n${lines.join('\n')}`
          })
          return 0
        } catch (error) {
          process.stderr.write(`awt site migrate: ${error.message}\n`)
          return 1
        }
      }
      const {extractDeclaration, renderDeclaration, PROJECT_CONFIG, DERIVED_CONFIG} = await import('@agent-wiki-toolbox/publish')
      const layout = values.site ? null : await resolveLayout()
      const site = values.site ? resolvePath(values.site) : layout?.siteDir
      if (!site) {
        process.stderr.write('awt site migrate: no awt.config.mjs here or in any parent. Run this from inside the project.\n')
        return 2
      }
      const tracked = resolvePath(site, PROJECT_CONFIG)
      if (!existsSync(tracked)) {
        emit(values, {ok: true, migrated: false, notes: [`no ${tracked}; nothing to migrate`]}, () => `no ${tracked}: nothing to migrate.`)
        return 0
      }
      const {declaration, notes} = extractDeclaration(parseYaml(readFileSync(tracked, 'utf8')))
      const block = renderDeclaration(declaration)

      // A carried registry path is copied as written, and a wiki that moved its
      // site since (docs/wiki + site -> wiki/site) leaves it pointing at nothing.
      // The resolver only warns about that, at build time, in a way that reads as
      // "the other wiki is not built" — so it is said here, where it can be fixed.
      for (const [prefix, entry] of Object.entries(declaration.registry ?? {})) {
        for (const key of ['buildIndex', 'publishedIndex']) {
          const rel = entry?.[key]
          if (typeof rel === 'string' && !existsSync(resolvePath(site, rel))) {
            notes.push(
              `registry.${prefix}.${key} names ${resolvePath(site, rel)}, which is not there; ` +
                'check whether that wiki moved its site (wiki/site is the current layout) or is simply not built',
            )
          }
        }
      }

      const configPath = layout?.configPath
      const text = configPath && configPath.endsWith('.mjs') ? readFileSync(configPath, 'utf8') : null
      const marker = 'export default {'
      const once = text !== null && text.indexOf(marker) !== -1 && text.indexOf(marker) === text.lastIndexOf(marker)
      const hasSite = text !== null && /^\s*site\s*:/m.test(text)
      let wrote = null
      if (hasSite) {
        notes.push(`${configPath} already has a site key, so the block was not written; compare it with the one below`)
      } else if (!values['dry-run'] && text !== null) {
        if (once) {
          const at = text.indexOf(marker) + marker.length
          writeFileSync(configPath, `${text.slice(0, at)}\n${block}${text.slice(at)}`)
          wrote = configPath
        } else {
          notes.push(`${configPath} has no single \`export default {\` to insert into; paste the block below`)
        }
      }

      const steps = [
        `review ${tracked}: what it changed from Quartz's default beyond the block is not carried`,
        `git rm ${tracked}`,
        `add ${DERIVED_CONFIG} to ${resolvePath(site, '.gitignore')} (awt site setup names every missing line)`,
        `git rm ${resolvePath(site, 'quartz.pin')} if it is still there; the toolbox pins Quartz now`,
        'awt site setup (if not already run), then awt site serve',
      ]
      const report = {ok: true, migrated: true, declaration, wrote, notes, steps}
      emit(values, report, () =>
        [
          wrote ? `wrote the site declaration into ${wrote}:` : 'the site declaration to add to awt.config.mjs:',
          '',
          block,
          '',
          ...notes.map((note) => `  note: ${note}`),
          'next:',
          ...steps.map((step, n) => `  ${n + 1}. ${step}`),
        ].join('\n'),
      )
      return 0
    },
  },
]

export function version() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  let stamp = ''
  try {
    stamp = readFileSync(new URL('../../../INSTALLED_FROM', import.meta.url), 'utf8').trim()
  } catch {
    stamp = 'working copy'
  }
  return `awt ${manifest.version} (${stamp})`
}
