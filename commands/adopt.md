---
description: Reconcile a project's own files against the skills it loads — strip restated mechanics, remove the wiring the plugin replaced, bring the machine's publishing config up to the current format, and report the choices that need a decision.
---

# The adoption sweep

Bring this project back into step with the skills it loads. Run it from the project root.

**The drift runs one way.** A skill moves; a project's `CLAUDE.md` and `meta/` notes do not move
with it. Every sentence a project copied out of a skill was correct on the day it was written and is
unfalsifiable afterwards — it still reads as local law long after the mechanic it describes changed.
The sweep converts as much of finding that as possible into a grep, because the parts that get
missed are the ones needing judgement.

**Five things run this, and not all run all of it.** A release landing is the only one with an event
behind it; the other four have none, which is why they were the ones missing.

| Trigger                                                                        | Sections |
|--------------------------------------------------------------------------------|----------|
| A new version of the plugin is installed                                       | All      |
| Asked whether the project is still in step with its skills — any phrasing      | All      |
| **You have written or rewritten a `meta/` note, or the project's `CLAUDE.md`** | 2, 3, 5  |
| **Content has been extracted out of this wiki into a skill**                   | 2, 3, 5  |
| **Asked to deduplicate the wiki, or to resolve contradictions in it**          | All      |

**The pull side has no fixed wording, so match on intent.** Nobody asks for "the adoption sweep".
They ask whether `meta/` is still right, whether a note still holds, why two files disagree, or for
the duplication in here to be cleaned up. Treat any request to reconcile the project's local files
against the skills it loads as this sweep, however phrased, and do not wait for a release to justify
running it — a project drifts from a skill that never changed, because the project moved.

**The authoring trigger matters most, because it is the only one that runs while the drift is being
made.** The others describe discovering drift that already exists. Authoring creates it: the mandate
is in context every turn saying not to restate the mechanics, and an agent writing a set of notes
applies that from memory, sentence by sentence, with nothing checking it.

## 1. What the plugin now owns, and what a project may still be carrying

Before the plugin, a wired project held three copied things. **All three are now the plugin's, and a
local copy is drift with teeth** — it is a second implementation nothing propagates a fix to.

| Leftover                                                  | Why it goes                                                      |
|-----------------------------------------------------------|------------------------------------------------------------------|
| A `wiki-docs:begin`/`end` block in `CLAUDE.md`            | The `SessionStart` hook injects it; the copy cannot be updated   |
| `.claude/hooks/wiki-docs-guard.sh` and its settings entry | The plugin guards by walking up to `awt.config.mjs`              |
| An `agent-wiki-toolbox` server in `.mcp.json`             | The plugin declares it; two entries mean two servers on one wiki |

Delete each one you find, and say so in the report. **Read-only mounts of other projects' wikis stay
in `.mcp.json`** — a mount is this project's choice, not a mechanic, and the plugin does not know it.

**One thing replaces all three: `awt.config.mjs` at the project root.** Every automatic part of the
plugin is gated on it and inert without it. If the project has a wiki and no config, that is the
finding — `/awt:init` writes one.

A project that genuinely needs its own guarding keeps a **separate** hook beside the plugin's,
registered as its own entry, and says in the file that it is a deviation and why. The two share the
marker file, so a session is denied once rather than twice.

## 2. Sweep for restated mechanics

```shell
grep -rniE 'awt|mdfmt|remark|wikilink|\[\[|okf|front.?matter|placeholder|orphan|dead.?end|split_by_heading|rename_tag|build_listing|allow-writes|workspace_info|quartz' \
  CLAUDE.md AGENTS.md README.md wiki/notes/index.md wiki/notes/log.md wiki/notes/meta/ wiki/site/README.md .claude/ 2>/dev/null
```

**`index.md` and `log.md` are in the list because they are the gap the rule's wording leaves.** Both
are OKF reserved names, so they exist in every wiki, and both carry prose *about* the wiki — a home
page explaining what a health check reports satisfies "not in `meta/`" while breaking the point of
it. Add whatever else tells an agent how to work here.

**That pattern is this plugin's vocabulary, and on either pull trigger it is too narrow.** List what
the project actually loads and add each skill's own terms and filenames.

Classify **every** hit and act:

| Hit                                                                     | Do                                                      |
|-------------------------------------------------------------------------|---------------------------------------------------------|
| A **choice** — this project's vocabularies, layout, axis, own commands  | Keep                                                    |
| A **mechanic** — a tool, a flag, a hazard, a format a skill defines     | Delete, leave a pointer by section name                 |
| A **declared deviation** — this project genuinely differs               | Keep, and make it say *that it is a deviation, and why* |
| **Subject matter** — a note whose topic *is* a tool this project builds | Keep                                                    |

The last two get mislabelled in both directions. A project pinning an older toolbox is a deviation
worth stating; a project describing how `awt` works because someone once found it useful is a copy.
A note telling you how to use a tool is a copy, while a note arguing what that tool should become is
the project's own work — **a wiki whose subject is its own tooling is full of the second kind.**

**A contradiction between a note and a skill is not a tie to break on the merits.** The table decides
it by subject, whichever side is better written, longer, or more recently touched. A `meta/` note is
not an authority about a mechanic, and a skill is not an authority about this project's choices.
Resolving one on which text reads more convincingly is how the stale copy wins.

**On the deduplication trigger, read the skills before comparing any two notes.** Left to itself such
a pass compares notes against each other, and that is the wrong axis: the copy that matters is
between a note and a file outside the wiki, which a wiki-scoped comparison cannot see.

## 3. Sweep for mechanics that have gone stale

Any local sentence naming a command, flag, tool or field that **no longer appears anywhere in the
skill** is either a declared deviation or a leftover. Leftovers do the damage — they are confidently
wrong rather than merely redundant.

**The names from before libraries are leftovers too.** `targets.yaml`, `default-target`,
`registry.d/`, `groups` and `overrides.d/` are gone from the machine config, a `mount` or a group is
now a collection, and `awt site register` takes `--collection`. A sentence telling an agent to use
any of them is stale; `--target` and `$AWT_TARGET` still work, as old names for `--library` and
`$AWT_LIBRARY`.

**One standing rewrite that test cannot reach: a local file naming any formatter other than `awt fmt`
is stale.** It escapes the test because the superseded name was a live command once and still reads
as one — `mdfmt` is the form this usually takes — so the hit looks current rather than like a
leftover. Rewrite it anyway, including where the file says both work, and including files outside the
wiki: the split that sent a README to one formatter and a note to another is itself the stale thing.

## 4. The machine's publishing config

**This is the machine's, not the project's**, so it runs once per machine, on the release trigger or
when a publish finds no library, and every project on the machine shares the result. The config is
`$AWT_CONFIG_DIR`, else `~/.config/awt/`.

**The config from before libraries is ignored without a word.** A machine with `targets.yaml`,
`default-target`, `groups`, `registry.d/` or `overrides.d/` and no `libraries/` gets no error: the
libraries listing comes back empty, and the Stop hook's publish skips. Look for those files whenever the
plugin is new on a machine.

| Found                                  | Do                                                       |
|----------------------------------------|----------------------------------------------------------|
| The old files, no `libraries/`         | Migrate, below                                           |
| `libraries/` and a `legacy/` beside it | Migrated. `legacy/` is the old files, kept for reference |
| `host/` with no container mounting it  | The old `awt site host` output. Nothing reads it         |
| Neither                                | Nothing to do                                            |

**Migrating rewrites every project's addresses, so it is the user's call.** Run
`awt site migrate --machine --dry-run`, show the libraries it would write and any wiki it reports and
leaves out, and wait for the go. Then, on the go:

1. `awt site migrate --machine`. The old files move to `legacy/`.
2. Read `libraries/*.yaml` with the user: collection paths and titles come from the old groups and
   are worth a look before anything is published at them.
3. In each wiki's project, `awt site publish` for the default library. Every address moved to its
   collection's path, and links between wikis are fixed only by rebuilding the wiki that holds them.
4. `awt site host --up`, when the machine serves its local library: it replaces the old container
   with one over the library's tree.
5. A library on another machine is published to only when asked, per the wiki-docs skill.

`legacy/` and `host/` go when the user says so, not before.

## 5. Report, do not silently rewrite

Deleting a restated mechanic is a documentation fix and needs no permission. **Changing a `meta/`
vocabulary is a project decision** — front-matter values, folder layout, the navigation axis, what
belongs in the wiki. Raise those with the user, with what you would change and why, and leave them
alone until answered.

Report what you deleted, what you rewrote, and what you are waiting on.

**Adoption is not a wiki edit.** It touches `CLAUDE.md`, `.claude/` and `meta/` prose — no notes are
created, renamed or moved, so nothing here needs the write verbs. A deleted paragraph can still take
a `[[link]]` with it, and the `Stop` hook will say so.
