#!/usr/bin/env bash
# Record what a session did to a wiki, so the Stop hook knows what to format and
# whether the graph is worth checking. Writes nothing but its own state.
#
# Three signals, because they earn different treatment at Stop:
#
#   .touched  anything at all happened, and the wiki root it happened in
#   .files    paths a file tool wrote, known exactly -- safe to format
#   .opaque   a shell command may have written notes we cannot name -- report only
#
# The distinction between the last two is the point. Formatting a path this
# session wrote is a fix; formatting the whole wiki because a shell command was
# seen would rewrite notes the session never opened. The first is done at Stop,
# the second is only reported.
#
# MCP verb calls set .touched alone. They serialise what they write, so there is
# nothing to format; but a delete can leave links dangling, so the graph moved.
#
# Fails open by design: anything wrong here lets the session continue.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input" 2>/dev/null)
session=$(jq -r '.session_id // "nosession"' <<<"$input" 2>/dev/null)
cwd=$(jq -r '.cwd // ""' <<<"$input" 2>/dev/null)

case "$tool" in
  Write|Edit|MultiEdit|NotebookEdit|Bash) ;;
  # The reads move nothing.
  *__search|*__check|*__resolve|*__connections|*__workspace_info) exit 0 ;;
  mcp__*agent-wiki-toolbox__*) ;;
  *) exit 0 ;;
esac

# A file tool names its path, and that path decides the wiki, not where the shell
# happens to stand: a session rooted above several projects writes into their
# wikis from outside all of them. A relative path is the cwd's.
path=""
case "$tool" in
  Write|Edit|MultiEdit|NotebookEdit)
    path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' <<<"$input" 2>/dev/null)
    [[ -n "$path" ]] || exit 0
    [[ "$path" == /* ]] || path="${cwd%/}/$path"
    ;;
esac

# Walk up to the project marker, the same way every awt command does. Parameter
# expansion rather than dirname: this runs after every matching tool call, and a
# fork per level is a fork too many.
if [[ -n "$path" ]]; then dir="${path%/*}"; else dir="${cwd:-$PWD}"; fi
root=""
while [[ -n "$dir" && "$dir" != "/" ]]; do
  [[ -f "$dir/awt.config.mjs" ]] && { root="$dir"; break; }
  dir="${dir%/*}"
done
[[ -n "$root" ]] || exit 0

state="${TMPDIR:-/tmp}/wiki-docs-${session}"

# The Stop hook runs wherever the session finished, which need not be inside the
# wiki any more, so the root is recorded here rather than walked for again there.
# One line per wiki, each once: a session can work in several, and every one of
# them is formatted, checked and published at Stop.
mark() {
  grep -qxF -- "$root" "$state.touched" 2>/dev/null ||
    printf '%s\n' "$root" >> "$state.touched" 2>/dev/null || true
}

# A verb call is a touch and nothing more.
case "$tool" in
  mcp__*) mark; exit 0 ;;
esac

# rootDir names the wiki's home, `wiki` when unsaid; `notes` is a fixed name
# inside it. Cached per root, because reading it is the only fork left on this
# path and the answer cannot change while a session runs.
cache="${TMPDIR:-/tmp}/wiki-docs-notesdir${root//\//_}"
if [[ -f "$cache" ]]; then
  notes=$(<"$cache")
else
  rootdir=$(grep -oE "rootDir:[[:space:]]*['\"][^'\"]+['\"]" "$root/awt.config.mjs" 2>/dev/null |
            head -1 | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/")
  notes="$root/${rootdir:-wiki}/notes"
  printf '%s\n' "$notes" > "$cache" 2>/dev/null || true
fi

if [[ "$tool" == "Bash" ]]; then
  cmd=$(jq -r '.tool_input.command // ""' <<<"$input" 2>/dev/null)
  # Two ways a shell command reaches a note: it names the notes path, or it is
  # already standing in it and uses a bare filename. The second is the case the
  # guard's own blind spot lets through, and the one worth catching here.
  hit=""
  case "$cmd " in
    *"$notes"/*|*"$notes"[[:space:]]*|*"$notes"\"*|*"$notes"\'*) hit=1 ;;
  esac
  case "${cwd:-}/" in
    "$notes"/*) hit=1 ;;
  esac
  [[ -n "$hit" ]] || exit 0
  : >> "$state.opaque" 2>/dev/null || true
  mark
  exit 0
fi

case "$path" in
  "$notes"/*) ;;
  *) exit 0 ;;
esac

printf '%s\n' "$path" >> "$state.files" 2>/dev/null || true
mark
exit 0
