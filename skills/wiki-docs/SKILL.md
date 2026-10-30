---
name: wiki-docs
description: Work with a wikilinked markdown wiki through the agent-wiki-toolbox, the `awt` CLI and its MCP tools - search and check the link graph, format notes, read and write front matter, and rename, move, split or merge notes with their links rewritten. Read it before restructuring or bulk-editing wiki notes with any tool, formatting a wiki, publishing one to a library or server, mounting another project's wiki, or setting one up.
---

# Wiki Docs

A wiki here is a directory of markdown notes with YAML front matter, linked by `[[wikilinks]]`.
The `agent-wiki-toolbox` (`awt`) reads that link graph and performs the edits that break it when
done by hand. This file describes the tool. What a wiki contains, how it is laid out and which
front-matter values it uses are the project's choices, carried in the project's own files.

`awt --help` and each command's `--help` are the authority on commands and flags, and the MCP
server describes its own tools. This file carries what those do not: order of use, and hazards.

## Where the wiki is

`awt.config.mjs` at the project root marks the project. Its `rootDir` names the wiki's home,
`wiki/` when unsaid, with `notes/`, `site/`, `schemas/` and `inbox/` as fixed names inside it.
Every command and the MCP server find the config by walking up, so an `.mcp.json` entry is
`awt mcp --allow-writes` and names no path. `-w <dir>` names a notes directory outright instead.

A project can run more than one server: its own wiki, plus other projects' wikis mounted
read-only. `workspace_info` reports `notesDir`, `rootDir`, `allowWrites` and the tag vocabulary
with counts, and is the call that tells servers apart.

## Before the first note

**Read the wiki's own choices before writing a note in it**: `index.md` at the root of the notes,
and `meta/` when there is one, or whatever the index points at instead. This file cannot say what
belongs in that wiki, how its notes are written, what its front-matter values mean or how it lays
out its folders. A note written without that reading follows the conventions of whatever wiki the
session saw last. `/awt:orient` is the same pass as one command.

Once per wiki per session is enough, and a session that only reads notes may skip it.

## Reading

| Tool             | What it answers                                                                                                  |
|------------------|------------------------------------------------------------------------------------------------------------------|
| `workspace_info` | Which wiki this server serves, whether it may write, which tags exist                                            |
| `search`         | Bodies, titles, front matter and tags in one call. A string or `/regex/flags`; filters on tag, type, area, topic |
| `connections`    | Links out of and into a note, optionally several hops                                                            |
| `resolve`        | What a link points at, and what else matched when it is ambiguous                                                |
| `check`          | Everything wrong with the graph, in one call                                                                     |
| `query`          | Inside one note's body by address: the outline, a section, a table as rows keyed by header, a column, a block    |
| `measure`        | Words, ISO dates and a pattern's hits, per note, in one call. Front matter is not counted                        |
| `frontmatter`    | What a note's front matter holds, and whether it satisfies its schema. Its write half needs `--allow-writes`     |

`check` returns `problems`, and separately `placeholders`, `orphans`, `deadends` and
`unreferenced`. It exits non-zero on problems only. A placeholder is a `[[link]]` to a note that
does not exist; the tool reports it and attaches no meaning.

### How links resolve

- A `[[stem]]` resolves by shortest path, so a basename shared by two notes resolves to neither.
  `resolve` names the candidates; a folder segment, `[[folder/note]]`, or a rename settles it.
- `[[folder/index]]` does not reach a listing one level down, though `[[a/b/index]]` reaches one
  two levels down. A relative markdown link, `[text](folder/index.md)`, does, and `check` validates it.
- Two files can render to one address: `x/x.md` beside `x/index.md`, `a b.md` beside `a-b.md`,
  names differing only in case. `check` reports every file in the group.
- `[[stem|label]]` is reported as a problem. `rename` rewrites the target and leaves the label.
- `![[embed]]` is a link: a node, an edge, and rewritten by `rename` and `move`.
- A relative markdown link to a file that is not a note, `[table](menu/codes.csv)`, is no edge,
  but `check` reports `broken-link` when no file is there. `move` does not rewrite it, so run
  `check` after moving a note that links to one.
- `[text](prefix:path.md)` is a reference into another wiki. `resolve` reports it as `crossWiki`
  and `check` counts it apart from placeholders. See `interop.md` beside this file.

## Writing

Write tools need a server started with `--allow-writes`. A read-only server does not list them;
of the writes only `fmt` is there, and only with `dryRun: true`. Each replaces a shell command
that breaks the graph:

| Tool                               | Instead of                                                                         |
|------------------------------------|------------------------------------------------------------------------------------|
| `rename` · `move`                  | `mv`, which leaves every inbound link pointing at nothing                          |
| `delete`                           | `rm`; links into the note are reported, not rewritten                              |
| `split_by_heading` · `merge_files` | Re-emitting whole documents                                                        |
| `rename_tag`                       | `sed`, which cannot tell front matter from prose                                   |
| `build_listing`                    | Hand-maintaining the notes table between markers in the index                      |
| `frontmatter`                      | `sed` over a YAML block, which loses comments and quoting                          |
| `body`                             | Re-emitting a note to change one section, or a regex over a table's rendered pipes |
| `fmt`                              | Any other formatter, see the hazard below                                          |

Prose edits are made with ordinary file tools; the index is recomputed on the next call. A note
written that way is formatted when the session ends; `awt check` runs then too, and so do the
front-matter schemas over the files the session wrote, holding the session open with the list if the
graph broke or a note stopped satisfying its schema. Only the paths a file tool wrote are
formatted. A note a shell command wrote is named in that report and left alone, because nothing
knows which files a shell command touched — run `awt fmt <path>` on it yourself.

- **Restructuring many notes is one `move` plan, not a sequence of moves.** Moved one at a time,
  each rewrite picks link qualifiers for a layout that is only part of the way there, and a later
  move makes them ambiguous. A plan writes every link once, against where the notes end up. A plan
  in which a destination is another pair's source is refused; split a chain or a swap into two.
- Nothing locks. A file that changed under a verb is listed in `skipped`, not overwritten, and
  running the verb again finishes the job.
- `unresolved` lists the links the verb would not guess at, such as an ambiguous stem.
- `split_by_heading` takes a heading-to-path plan and a source fate of `delete`, `stub` or
  `keep`. A target that already exists is skipped and reported; the other sections proceed.
- Every write accepts `dryRun`.

### The body, addressed by segment path

`body` writes what `query` reads, at the same address: a path of segments, each resolving inside what
the one before it found — `section`, `heading`, `block`, `table`, `row`, `column`, `cell`, `list`,
`list_item`. **Read the address with `query` first.** Its outline names the path to every heading, and
a table comes back as rows keyed by its header — the only reading of a table that survives the
formatter re-aligning its columns.

Each segment carries a name and a position and **the name wins**. Pass both and a segment that finds
*Fields* at 1 rather than the 3 you gave edits the one you named and reports the disagreement, which
is how you learn the note moved under you; pass the ordinal alone and there is nothing to disagree
with. So **`delete`, and a `move` that leaves its container, refuse a segment with no name**: a wrong
replace puts content somewhere a reader notices, a wrong delete leaves nothing and nobody does. A
caller that read the target can name it, and what went comes back in `removed` as markdown.

**Payload writes are MCP-only.** `awt query` reads a body from the command line and there is no
`awt body`: a payload is a document, and a document on argv is a quoting hazard.

### Front matter is a separate domain

`frontmatter` is one command, read and write, over the YAML block alone — **the markdown body is not
reachable from it, and no verb reaches across the two**. They are two documents sharing a file: a key
against a node path, and hazards with nothing in common. So "rewrite this section and mark it
`stable`" is two calls, and the second can fail after the first landed; the two do not interfere, so
that is a half-landing and never a wrong edit.

Three axes: the operation, the scope it acts at, and the key.

| Operation          | Scope     | Effect                                          | CLI                      |
|--------------------|-----------|-------------------------------------------------|--------------------------|
| `read`             | `block`   | The whole block as data                         | `awt frontmatter <path>` |
| `read`             | `content` | One key's value                                 | `--get KEY`              |
| `replace`          | `content` | Set a key's value, adding it if it is absent    | `--set KEY=VALUE`        |
| `replace`          | `marker`  | Rename a key, leaving the value                 | `--rename OLD=NEW`       |
| `replace`          | `block`   | Replace the block wholesale                     | `--replace-block`        |
| `delete`           | `content` | Drop a key                                      | `--unset KEY`            |
| `append`/`prepend` | `content` | Add to a sequence-valued key                    | `--append KEY=VALUE`     |
| `validate`         | `block`   | Whether the note satisfies its schema           | `--validate`             |
| `schema`           | `block`   | Which schema claims this path, and what it says | `--schema`               |

- **Every write is checked against the schema for that path, and the check reports rather than
  refuses.** The violation comes back in `violations` under the code `FRONTMATTER_SCHEMA_VIOLATION`,
  and the write lands. A single write is not the unit a schema applies to: renaming a field across a
  wiki passes through a state where the old key is gone and the new one is not declared, and a
  refusing verb would refuse the edit that was on its way to making things valid. Ask `validate` when
  the migration is done; the Stop hook asks it of everything a session wrote.
- The failures that *are* refusals are about ambiguity, absence or type:
  `FRONTMATTER_KEY_NOT_FOUND`, `FRONTMATTER_KEY_COLLISION`, `FRONTMATTER_NOT_A_SEQUENCE`,
  `FRONTMATTER_ABSENT`.
- **Every scope but `block` keeps the author's YAML**: comments, quoting, and `tags: [a, b]` written
  flat. `block` reserialises from data and loses all three, so it is for front matter the toolbox
  derived rather than a person wrote, and it says so — `derived: true`, or `--derived` with the
  object on stdin. It is also the only scope that creates a block a note does not have.
- A key with no block to edit is `FRONTMATTER_ABSENT`, not an invented block.
- **`append`/`prepend` are lenient about absence and strict about type.** A key that is not there is
  created holding the one item, and the report says it created rather than appended. A key holding a
  scalar is `FRONTMATTER_NOT_A_SEQUENCE` — a different failure, and collapsing the two would turn a
  mistyped key name into a field quietly created beside the one that was meant.
- **`validate` has three answers, not two.** The note satisfies its schema, it does not, or no
  schema claims the path — and the third is not a pass. A note written one folder below where the
  globs reach is invisible to `awt fmt --dry-run` and to the Stop hook as well, so `unchecked` is
  the only thing that ever says so.
- The CLI takes one operation flag per call and refuses two. `--unset` rather than `--delete`,
  because `awt delete` deletes a note. `--validate` exits non-zero on an invalid note; `--schema`
  prints the path alone, and `--json` carries the schema itself so a caller needs no second read.

#### Ask the schema before writing a note's front matter

**Ask `schema` for the path, then write the fields it requires.** The path is known before the write
— a write tool cannot be called without one — and the schema is the part that is not.

The habit this replaces is opening a **sibling note** to see what its front matter looks like and
copying the shape. That inherits whatever the sibling got wrong, and it spreads: the next note is
copied from this one. `schema` answers from the schema itself, for a path that need not exist yet.

An empty answer means no schema claims the path, and **that is all it means**. It is not a hint that
the note belongs somewhere else; nothing here checks placement, and a note in the wrong folder that
satisfies its schema is not something any of this catches.

**The two surfaces are spelled differently, and no longer name quite the same set.** MCP tool names
are flat and keep their qualifiers — `split_by_heading`, `merge_files`, `build_listing`. The CLI
drops those (`awt split`, `awt merge`, `awt listing`) and groups the site commands under `awt site`,
which is a namespace and not an alias: there is no flat `awt serve` still working. One name exists
on one surface only — **`rename` is an MCP tool and not a command**, because the CLI folded it into
`awt move`, where a destination with no folder in it renames in place. `awt --help` is the
authority; this is only the warning not to translate a tool name into a command by habit.

Bare `awt check` and `awt fmt` mean the whole wiki from anywhere in the project. `awt fmt <path>`
resolves the path against the current directory, or against the workspace when `-w` is given; the
MCP `fmt` takes workspace-relative paths, and its `dryRun` is the CLI's `--dry-run`. `awt fmt --dry-run`
also runs the front-matter schemas that `awt.config.mjs` maps onto files.

## Formatting hazard

`awt fmt` tokenises `[[wikilinks]]` and `![[embeds]]`. A remark pipeline without a wikilink
plugin escapes them to `\[\[x]]` and `!\[\[x]]`. Both still render, so the diff looks cosmetic
while every edge in the graph is gone. After a bulk markdown operation by any other tool, run
`awt check` and compare `grep -rc '\[\['` counts before and after. `awt fmt` is also the formatter
for markdown with no wiki around it — a README, a `CLAUDE.md`, a docs tree — because `format` does not
depend on `core`; there is no second formatter to choose between.

## Front matter, an optional shape

```yaml
---
title: <matches the H1>
type: <string>
description: <one sentence>
status: <draft | stable | deprecated>
tags: [<tag>, <tag>]
---
```

A project that fixes vocabularies can hold them as JSON schemas in `wiki/schemas/`, mapped to
globs in `awt.config.mjs`. Three things ask them, and none of them refuses a write:
`awt fmt --dry-run` over any set of files, `frontmatter --validate` about one note, and the Stop hook
about everything a session wrote.

## Open Knowledge Format, optional

[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) is a vendor-neutral
spec for markdown knowledge bundles, and a wiki of this shape is close to one. Whether a project
has adopted it is the project's to say. The parts that touch how notes are written:

| Field      | Detail                                                                          |
|------------|---------------------------------------------------------------------------------|
| `type`     | Required, a non-empty string. Values are producer-defined                       |
| `index.md` | Reserved for a listing; no front matter except `okf_version` at the bundle root |
| `log.md`   | Reserved for a chronology, newest first, `YYYY-MM-DD` headings                  |
| `status`   | `draft` · `stable` · `deprecated`; absent means `stable`                        |
| `sources`  | A list of mappings, each with `resource`                                        |
| `verified` | A list of `{by, at}`; `generated` names the author. Extra keys are legal        |

OKF expresses the graph as bundle-relative markdown links. The toolbox reads `[[wikilinks]]`, so
a wiki using both keeps its edges in wikilinks and a generic OKF consumer sees the notes without
the edges. That is a legal extension, not a conformance break.

## Publishing

A wiki is published as a static site into one or more **libraries**, each a base URL on some server,
declared on the machine in `~/.config/awt/libraries/`. `awt site wikis --key <key>` names the
libraries that hold a wiki and its address in each; the names are the machine's, so read them there
rather than assuming any.

| Asked for                         | Run, in the wiki's project                                         |
|-----------------------------------|--------------------------------------------------------------------|
| Publish this wiki                 | `awt site publish`: the default library                            |
| Publish it to a named library     | `awt site publish --library <name>`: builds it and copies it there |
| Republish every wiki in a library | `awt site publish --library <name>` in each wiki's project         |
| Resend what is already built      | `awt site deploy --library <name>`                                 |

- **The default library is kept current without asking.** The plugin's Stop hook rebuilds a wiki's
  release there when a note is newer than it. Nothing else is published by anything but a request.
- **A library on another machine is reached only when a person asks.** Never publish to one unasked,
  and never from a hook or a watch.
- **Offer once, after a significant change.** When a session added notes, restructured or rewrote a
  wiki that a library on another machine holds, say at the end that that server still shows the old
  version and offer to publish there. A typo fix is not significant. Do not repeat the offer in the
  session.
- **A first publish to a library is a person's decision.** It fixes an address, and a wiki the library
  does not hold is refused with the `awt site register` command that would add it.

## Other wikis

`interop.md` beside this file covers wikis mounted read-only, references across wikis, and an
optional message convention.
