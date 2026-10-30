# agent-wiki-toolbox

One toolbox for a markdown wiki whose notes are connected by `[[wikilinks]]` — the link graph,
structural edits that keep it intact, formatting, and the build that renders it as a site.

**All seven packages are built.** `syntax`, `core`, `format`, `verbs`, `mcp`, `cli` and `publish` all
work, and both local sites build through them. What is outstanding is the switch: Foam and the old
site tooling still run alongside, and retiring them waits on a soak of the shadow resolver.

## What it replaces

Three things that currently do this job separately, each with its own model of what a link is:

- **Foam** — the link graph and the MCP server an agent talks to
- **`markdown-toolbox`** — the `mdfmt` formatter
- **`quartz-wiki-tools`** — the site build and the cross-wiki resolver

`markdown-toolbox` is now retired: `@agent-wiki-toolbox/format` reimplements `mdfmt` on remark with
no dependency on it, byte-identically, so `awt fmt` is the formatter for a README and a `CLAUDE.md`
as much as for a note. The other two keep working while this is built.

## The layers

```text
        syntax          the mdast dialect: remark plugins, wikilink config
        /     \
     core     format    core   = resolver, index, graph, cache
        \     /         format = IntelliJ-identical serialisation
         verbs          split / move / merge / listing — needs both
        /  |  \
  mcp   cli   publish   nothing below depends on these
```

Each is a workspace package, so **the dependency graph is the architecture** and a layering violation
fails a check rather than a review. `bun run layering` is that check.

Two of its rules are load-bearing rather than tidy:

- **`format` must not depend on `core`.** It is what keeps formatting a lone `CLAUDE.md` possible
  with no wiki anywhere in sight.
- **`core` must not depend on `mcp` or `cli`.** It is what keeps the index a pure function of the
  file tree — which is what makes it cacheable on disk with no watcher.

## What `syntax` settles

The dialect is **ours**, not `remark-wiki-link`'s. One micromark construct covers `[[stem]]`,
`[[folder/stem]]`, `[[stem#anchor]]`, `[[#anchor]]`, `![[embed]]` and the aliased form the estate
bans, producing one node type:

```js
{type: 'wikiLink', embed: false, target: 'folder/stem', anchor: 'a-heading', alias: null}
```

Three consequences the layers above depend on:

- **An embed is a link.** It is a node rather than escaped text, so it is a graph edge and a rename
  rewrites it through the serialiser like anything else.
- **An anchor is a field**, which is what makes it checkable against the heading index.
- **Nothing un-escapes anything.** A serialised document needs no repair pass, so a note *about* this
  syntax survives being formatted.

Resolution lives in `core`. This package deliberately does not know what a target points at.

## The binary

One command, `awt`, with everything as a subcommand — the verbs, formatting, the graph, the MCP
server and the site build. There is no second binary to reach for.

```shell
awt --help                       # every operation, in sections
awt check                        # everything wrong with the link graph, in one call
awt search 'unique basenames'    # note bodies, titles, front matter and tags
awt query a.md                   # the outline: every heading and the address that reaches it
awt query a.md --address '[{"table": {}}]'   # …a table as rows keyed by its header
awt measure design/              # words, ISO dates and a pattern's hits, per note
awt move a.md design/a.md        # …rewriting every link into it
awt move a.md b.md               # no folder in the destination means rename
awt move old/ new/               # a folder moves as one plan, links written once
awt move --plan plan.json         # …or any plan, as [{"from", "to"}] pairs
awt frontmatter a.md             # the whole block, as the note holds it
awt frontmatter a.md --set status=stable    # …one key, checked against the schema
awt frontmatter a.md --validate  # does this note satisfy its schema? (writes nothing)
awt frontmatter a.md --schema    # which schema claims this path — ask before writing a note
awt mcp --allow-writes           # the MCP server, over stdio

awt site setup                   # install or re-pin the renderer a site builds from
awt site serve                   # emit the index and the config, then Quartz's dev server
awt site proxy                   # several wikis behind one port, each at /<prefix>/
awt site proxy --install         # …as a user service: launchd, systemd or a logon task
awt site publish                 # build, then swap into wiki/site/build/published/<base>
awt site publish --base http://localhost:8088/wikis --mount shelton --name dios
                                 # …for one address: <base>/<mount>/<name>/
awt site publish --watch         # keep the published site current while you edit: a save is live in about a second
awt site publish --if-stale      # rebuild only if a note is newer than the standing release; never a first release (what the Stop hook runs)
awt site publish --library proton  # …for a library in ~/.config/awt/libraries/proton.yaml, at its collection's path
awt site verify                  # does the published site carry the address this project says it is built for?
awt site register --collection tools  # put this wiki in a collection of the default library (--library for another)
awt site wikis                   # the machine's libraries and collections, and each wiki's address in each
awt site unregister dios         # take a wiki out of a library
awt site deploy --library proton # copy a library's releases, pages and nginx config to its deploy.to, by rsync
awt site clean                   # remove wiki/site/build/, which holds everything awt generates; --legacy for the old loose files
awt site host --up               # deploy the local library and serve its tree: nginx in Docker
awt site index                   # just the artifact the Quartz plugin reads
awt site migrate                 # lift a tracked quartz.config.yaml into awt.config.mjs
awt site migrate --machine       # lift targets.yaml and registry.d into awt.yaml and libraries/
```

**Everything `awt` generates for a site is in `wiki/site/build/`**, and that directory ignores itself, so a
project's `.gitignore` needs one line, `node_modules/`, and no feature that writes something new adds another.
It holds the link index, the derived Quartz config, `dev/` (`awt site serve`), `published/<base>/` (one per
target) and `handoff/`. A project from before it has the old loose files beside `package.json`;
`awt site setup` names them and `awt site clean --legacy` removes them.

**The Quartz config is the toolbox's, derived before every build.** Quartz reads
`quartz.config.yaml` from its own directory and nothing else, and every wiki's copy was Quartz's
shipped default plus the same handful of changes, so the toolbox now writes that file
(`wiki/site/build/quartz.config.yaml`) from the pinned install's own default, its own changes,
and what the project declares under `site` in `awt.config.mjs`:

```js
site: {
  title: 'DIOS wiki',                // the page title
  self: 'shelton-dios',              // this wiki's cross-wiki prefix; its registry entry is derived
  registry: {'shelton-dios-data': {dev: 'http://localhost:8102', buildIndex: '../../…/contentIndex.json'}},
  baseUrl: 'wiki.example.org',       // the base a release is served from: a host and path, https unless a scheme is written
  mount: 'shelton',                  // with baseUrl, serves the release at <baseUrl>/<mount>/<self>/
  properties: ['type', 'status'],    // front-matter fields shown on a page
  footer: {GitHub: 'https://…'},     // footer links
  plugins: [{source: './plugins/mine', options: {}, order: 70}],   // extra Quartz plugins, passed through
}
```

A change inside the toolbox — a plugin option, a Quartz pin bump that renames a community plugin —
reaches every wiki on the next build without touching a project's files. A project that needs what
the declaration does not expose tracks its own `wiki/site/quartz.config.yaml`, which replaces the
derived base wholesale; the toolbox still injects its one plugin entry into it. The one Quartz plugin,
`quartz-plugins/awt`, is named in that entry by absolute path into the install, and Quartz links it
itself; nothing of the toolbox is symlinked into a project any more.

**`awt site proxy` keeps every wiki at one bookmarkable address.** It reads a config listing wikis
by prefix — `~/.config/awt/proxy.json` unless `--config` names another — and serves each at
`http://localhost:<port>/<prefix>/`. A wiki's own `awt site serve` starts on the first request for
it, on ports the proxy picks, and stops after `idleMinutes` without a request; the proxy itself stays
up whatever the wikis do. `/` lists the wikis and their state, and a wiki that is starting, has
exited or is not listed gets a page saying so, with the serve's own last lines when it exited. It
works because every link Quartz emits is relative, so an unmodified dev server does not know which
prefix it is behind. One config is one proxy: a second config on a second port is a second set of
wikis. `--install` makes it a service that starts at login and restarts when it exits; `--dry-run`
shows the file and the commands first. Quartz's hot-reload socket bypasses the proxy, so a page left
open across a wiki's restart needs a manual refresh.

**`site` is the one group, and a group is a namespace rather than an alias** — there is no flat
`awt serve` kept working beside `awt site serve`. It is grouped because its four commands share a
flag family (`--wiki`, `--site`) that nothing else has, which is the test: **a group's options are
the definition of what the group is**, so grouping the graph reads under their `-w` and `--json` —
the tool's defaults — would have defined nothing. `awt site setup` also stops a command name
carrying the renderer's.

**Front matter is its own command, and the markdown body is not reachable from it.** They are two
documents that happen to share a file: different parsers, different addresses — a key against a node
path — and unrelated hazards. `awt frontmatter` reads the block or one key, sets, renames, drops or
appends to one, and checks every write against the schema for that path — the same check
`awt fmt --dry-run` runs, asked before the bytes land. **It reports and does not refuse**: a single
write is not the unit a schema applies to, and a migration passes through states no schema accepts
on its way to one it does. `--validate` asks the question on its own, and the Stop hook asks it of
everything a session wrote. Replacing the whole block reserialises it and loses an author's comments
and quoting, so it needs `--derived` and takes its object from stdin.

**The markdown body is a third domain, and its writes are not on this binary.** `awt query` reads
inside a note by address — a path of segments, `section`, `heading`, `block`, `table`, `row`,
`column`, `cell`, `list`, `list_item` — and the `body` MCP tool writes at that same address, with
`replace`, `insert`, `delete`, `move` and `shift_level` as the addressed kind allows. Nothing is
string-spliced: a payload is parsed and printed by the pipeline the note itself came through, so a
`[[link]]` survives it, and a delete or a relocating move is refused unless the address names what it
is removing. **Payloads stay off argv** — a payload is a document, and a document on argv is a
quoting hazard — which is why there is no `awt body`, and why the read's `--address` is named for the
verb's own argument rather than sharing `--path` with the commands that mean a note by it.

**Every command finds the project from anywhere inside it**, by walking up to `awt.config.mjs` at
the project root. That file names the wiki's home once, and every other directory is a fixed name
inside it:

```
awt.config.mjs      # the marker; rootDir names the home, and defaults to ./wiki
wiki/
  notes/            # the wiki root — what -w means when you do not pass it
  site/             # quartz.config.yaml, package.json + bun.lock, and the build's leavings
  schemas/          # front-matter schemas
  inbox/            # the interop inbox
```

```js
export default {
  rootDir: './wiki',                    // the default; write it only to move the home
  serve: {port: 8101},                  // wsPort defaults to port + 100
  schemas: {'./wiki/schemas/note.schema.json': ['meta/**/*.md']},   // globs are notes-relative
}
```

A bare `awt fmt` inside a project means the notes too, unless the config's `files` says otherwise.
`-w` and `$AWT_WORKSPACE` still name the notes outright, which is what a scratch directory with no
project around it needs. With no project above it and nothing named, a command reads the directory
it was started in as the wiki — a real case, and one that says so on stderr, because the answer it
gives is otherwise indistinguishable from a real one. `AWT_QUIET_WORKSPACE=1` silences that. A
project still laid out as `docs/wiki` beside `site/` keeps working, with one line on stderr saying
how to move, and `/awt:move-layout` carries the steps.

**bun installs it and bun runs it**, pinned with node in `mise.toml`: `bun install`, then
`bun run test` and `bun run layering`. Both binaries carry a `bun` shebang.

node stays pinned for two reasons. The test runner is `node --test`, because `bun test` shares one
process across files and the tests that assert behaviour *per working directory* leak into each
other there — every one of them passes when its file is run alone, and the same schema check passes
end to end through the real CLI under bun. And the Quartz plugins are imported by Quartz's own node
process, which is what keeps this source plain node-compatible ESM rather than anything bun-specific.

Install it with `scripts/install`, the only step that exposes a change. It copies this working copy
to `~/.claude/skills/awt`, where Claude Code adopts it as the **`awt` plugin** — and points
`~/.local/bin/awt` at the same tree, so a shell, a site build and a session all run one copy.
`SETUP.md` has the full sequence, including moving a machine off the pre-plugin `bin/install` +
`skills add` setup.

What the plugin is, beyond the binary:

| Part                                                                 | What it does                                                                                                                                                                                                                                                                                                |
|----------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| The `wiki-docs` skill, as `/awt:wiki-docs`                           | The tool, its verbs and the hazards                                                                                                                                                                                                                                                                         |
| The MCP server                                                       | The verbs over whichever project's wiki the session is in                                                                                                                                                                                                                                                   |
| `SessionStart`, `SubagentStart`, `PreToolUse`, `PostToolUse`, `Stop` | Inject the mandate, hand a subagent the same one, guard the first wiki write, report what the structural verbs refused, carry the touch record through a compaction, then format what the session wrote, check the graph, and rebuild a published wiki's release if a note is newer than it, before it ends |
| `/awt:check` · `/awt:orient`                                         | The everyday two: both health checks as one answer, and the reading pass before work starts                                                                                                                                                                                                                 |
| `/awt:adopt` · `/awt:move-layout` · `/awt:init`                      | The deliberate acts: the drift sweep, the layout move, bootstrapping a wiki                                                                                                                                                                                                                                 |

Every automatic part is gated on `awt.config.mjs` and inert without it, so a project is not something
that installs the plugin — it is something the plugin recognises.

## The Quartz plugin

One package, `quartz-plugins/awt`, declared to Quartz as both a transformer and an emitter. It reads
the index `awt site index` writes and computes nothing of its own: a note beside a folder of its own
name is served at the address the index gives it, `prefix:path.md` links resolve through the target
wiki's own content index, every page's heading anchors are published beside `contentIndex.json`, and
the shadow compares Quartz's link resolution against the toolbox's and fails the build on a
disagreement. `shadow: false` in its options is the resolver switch, when its gate is met. It has no
dependencies, because Quartz imports it through a symlink from which nothing else resolves.

## Where the reasoning lives

This repo carries the code. The design, the thirty-three decisions behind it and the measurements
they rest on are in the AiSandbox workspace wiki, under the `agent-wiki-toolbox` topic —
`wiki/notes/projects/agent-wiki-toolbox/design/toolbox-shape.md` is the entry point, and `docs/awt-plan.md` is
the milestone-by-milestone plan.

That wiki is where this was designed, not a dependency: **this repo has to be clonable and workable on
its own**, and nothing in it may reference the workspace at build or run time.

## Status

**ALPHA.** No tags, no releases, no npm publish planned. Install from a working copy; ask what is
running with `awt --version`.
