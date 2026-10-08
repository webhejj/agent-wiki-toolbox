#!/usr/bin/env bash
# Format what the session wrote and check the graph before the session ends.
#
# Why Stop and not PostToolUse: a hook that formats after every Write changes the
# file under the agent and breaks the next Edit. At Stop the agent is done, so a
# rewrite costs nothing -- but only of files this session actually wrote, which
# is what wiki-docs-touch.sh records. A shell command that may have written notes
# we cannot name is reported, never silently reformatted: the blast radius of a
# whole-wiki fmt is every note, and the session opened a handful.
#
# The graph half is `awt check`. Problems block the stop and come back as the
# list; placeholders, orphans and dead ends do not -- the distinction check
# already draws, and the one a session must not be held hostage to.
#
# The schema half asks the same file list one more question. It used to run only
# in the opaque-write branch, so an ordinary session that edited front matter had
# nothing checking its schemas before it ended -- and `awt frontmatter` reports a
# violation rather than refusing the write precisely because a single write is not
# the unit a schema applies to. This is where that lands instead, and it covers
# every route in: a verb, an Edit, a Write. One `fmt --dry-run` over the list
# rather than one call per file, and it is the same plugin either way, so the two
# cannot disagree.
#
# Fails open by design: anything wrong here lets the session end. Bash 3.2, which
# is what macOS ships, so no mapfile and no associative arrays.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
session=$(jq -r '.session_id // "nosession"' <<<"$input" 2>/dev/null)

state="${TMPDIR:-/tmp}/wiki-docs-${session}"
[[ -f "$state.touched" ]] || exit 0

# Every wiki the session touched, one per line; a session rooted above several
# projects can have written into more than one.
roots=()
while IFS= read -r r; do
  [[ -n "$r" && -d "$r" ]] && roots+=("$r")
done < <(sort -u "$state.touched" 2>/dev/null)
(( ${#roots[@]} )) || exit 0

# The plugin's own binary, not whatever a shell profile put on PATH: a session is
# checked by the toolbox it was run with.
plugin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || exit 0
awt="$plugin/bin/awt"
if [[ ! -x "$awt" ]]; then
  awt=$(command -v awt 2>/dev/null) || exit 0
fi
[[ -n "$awt" ]] || exit 0

# The escape byte as well as the bracket sequence after it. Stripping only the
# second leaves a bare ESC at both ends of every filename the formatter prints,
# so a line that reads as `meta/a.md` does not end in `.md` and nothing matching
# on it works. The old pattern is kept beside it rather than replaced, since it
# is what every existing report was read through.
strip_ansi() { sed -e $'s/\033\[[0-9;]*m//g' -e 's/\[[0-9;]*m//g'; }

report=""
add() { report="$report$1"$'\n'; }

# Which wiki a written file belongs to: the deepest root that contains it, the
# one wiki-docs-touch.sh found by walking up from the file.
owner() {
  local best="" r
  for r in "${roots[@]}"; do
    case "$1" in
      "${r%/}"/*) (( ${#r} > ${#best} )) && best="$r" ;;
    esac
  done
  printf '%s' "$best"
}

formatted=0
for root in "${roots[@]}"; do
  cd "$root" 2>/dev/null || continue

  # With more than one wiki, each part of the report says which one it is about.
  section=""
  (( ${#roots[@]} > 1 )) && section="In \`$root\`: "

  # 1. Format exactly what the session wrote in this wiki, and nothing else.
  #    Idempotent, so the second stop after a block re-runs it for nothing rather
  #    than for harm.
  # Reset per wiki, and declared before the branch because step 3 asks the same
  # list its own question, and an array that only exists inside the branch is an
  # unbound variable under `set -u` on every session that wrote nothing.
  live=()
  if [[ -s "$state.files" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" && -f "$f" && "$(owner "$f")" == "$root" ]] && live+=("$f")
    done < <(sort -u "$state.files" 2>/dev/null)
    if (( ${#live[@]} )); then
      n=$("$awt" fmt --json "${live[@]}" 2>/dev/null | jq -r '.files // 0' 2>/dev/null)
      [[ "$n" =~ ^[0-9]+$ ]] && formatted=$(( formatted + n ))
    fi
  fi

  # 2. A shell command may have left an unformatted note behind. Name it; do not
  #    reach into notes this session never opened.
  if [[ -f "$state.opaque" ]] && ! "$awt" fmt --dry-run >/dev/null 2>&1; then
    add "${section}A shell command in this session wrote into the wiki, and notes are unformatted:"
    add ""
    add "$("$awt" fmt --dry-run 2>&1 | strip_ansi | head -20)"
    add ""
    add "Run \`awt fmt <path>\` on what you wrote. Not the whole wiki, unless you meant to."
    add ""
  fi

  # 3. The schemas, over the files this session wrote. `fmt` in step 1 has already
  #    formatted them, so the only thing left for --dry-run to say about them is
  #    what the front-matter schemas say -- and the filter keeps it to exactly
  #    that, so an unformattable file is not reported here under the wrong heading.
  #    A project that maps no schemas gets no output and no step.
  if (( ${#live[@]} )); then
    schema=$("$awt" fmt --dry-run "${live[@]}" 2>&1 | strip_ansi |
             awk '/^[^[:space:]].*\.(md|markdown)$/ {file=$0; next}
                  /frontmatter-schema/ {print "  " file " " $0}')
    if [[ -n "$schema" ]]; then
      add "${section}Front matter this session wrote does not satisfy its schema:"
      add ""
      add "$schema"
      add ""
      add "Fix the fields, or say why the schema is wrong. \`awt frontmatter <path> --validate\` re-asks."
      add ""
    fi
  fi

  # 4. The graph. Problems only; placeholders and orphans are reported by check
  #    separately and are not failures.
  problems=$("$awt" check --json 2>/dev/null |
             jq -r '(.problems // [])[] | "  \(.path):\(.line) [\(.rule)] \(.message)"' 2>/dev/null)
  if [[ -n "$problems" ]]; then
    add "${section}\`awt check\` found problems in the link graph:"
    add ""
    add "$problems"
    add ""
    add "Fix them with the awt verbs before finishing."
    add ""
  fi
done

[[ -n "${report//[[:space:]]/}" ]] || exit 0

(( formatted > 0 )) && add "($formatted note(s) this session wrote were formatted on the way out.)"

# A blocked stop that keeps blocking is worse than an unfixed link. Twice is
# enough for the agent to see the list and act on it; after that the report is
# printed and the session is let go.
blocks=0
[[ -f "$state.blocks" ]] && blocks=$(<"$state.blocks")
[[ "$blocks" =~ ^[0-9]+$ ]] || blocks=0
if (( blocks >= 2 )); then
  printf '%s\n' "$report"
  exit 0
fi
printf '%s\n' "$(( blocks + 1 ))" > "$state.blocks" 2>/dev/null || true

jq -n --arg r "$report" '{decision: "block", reason: $r}'
exit 0
