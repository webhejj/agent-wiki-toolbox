#!/usr/bin/env bash
# Give the agent back the list of notes it edited, after compaction took it away.
#
# The touch record already knows which notes this session wrote -- it is what the
# Stop hook formats and what decides whether the graph is worth checking. That
# record lives in a file and survives compaction untouched. What does not survive
# is the agent's own memory of having written them, and the two disagreeing is the
# failure: the Stop hook formats a file the agent no longer knows it touched, and
# the agent, asked what it changed, has the wrong answer.
#
# So on `SessionStart` with source `compact`, read the record back out and inject
# it. Nothing is recomputed and nothing is written; this hook only says out loud
# what the session already recorded.
#
# `SessionStart` cannot use an `mcp_tool` hook -- servers have not connected when
# it runs -- which is why this is a command hook like the mandate beside it.
#
# Fails open by design: a session that comes out of compaction with no list is a
# session that formats nothing at Stop, not a session that breaks. Bash 3.2.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || true)
source_kind=$(jq -r '.source // ""' <<<"$input" 2>/dev/null)
session=$(jq -r '.session_id // "nosession"' <<<"$input" 2>/dev/null)

# The matcher in hooks.json already says `compact`. Checked again because a hook
# that fires on `startup` would inject a stale list from a previous run of the
# same id, and because the matcher is the only thing standing between the two.
[[ "$source_kind" == "compact" ]] || exit 0

state="${TMPDIR:-/tmp}/wiki-docs-${session}"
[[ -f "$state.touched" ]] || exit 0
# One line per wiki the session touched. With one, paths are shown relative to it;
# with several, in full, since a relative path would not say which wiki it is in.
roots=$(sort -u "$state.touched" 2>/dev/null)
[[ -n "$roots" ]] || exit 0
root=""
[[ "$roots" == *$'\n'* ]] || root="$roots"

context=""
add() { context="$context$1"$'\n'; }

# Paths as they were recorded: absolute, because the Stop hook runs wherever the
# session ended. Shown relative to the project root, which is how they were named
# in the conversation that has just been compacted away.
LIMIT=40
files=""
count=0
if [[ -s "$state.files" ]]; then
  # Trimmed with parameter expansion rather than sed, because a project path is not
  # guaranteed to be free of the characters a sed expression reads as its own.
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if [[ -n "$root" ]]; then files="$files${f#${root%/}/}"$'\n'; else files="$files$f"$'\n'; fi
    count=$(( count + 1 ))
  done < <(sort -u "$state.files" 2>/dev/null)
  files="${files%$'\n'}"
fi

if (( count > 0 )); then
  add "**This session has already edited $count wiki note(s)**, recorded before the compaction:"
  add ""
  add "$(printf '%s\n' "$files" | head -"$LIMIT" | sed 's/^/  /')"
  (( count > LIMIT )) && add "  … and $(( count - LIMIT )) more"
  add ""
  add "They are formatted on the way out and the link graph is checked against them,"
  add "so the work is not lost. The list is here so that what you say you changed"
  add "matches what you changed."
  add ""
else
  add "**This session has already touched the wiki at:**"
  add "$(printf '%s\n' "$roots" | sed 's/^/  /')"
  add ""
  add "No note was written through a file tool. The link graph is checked before the session ends."
  add ""
fi

if [[ -f "$state.opaque" ]]; then
  add "A shell command in this session also reached into the wiki, and what it wrote"
  add "cannot be named. Unformatted notes are reported at Stop rather than rewritten."
  add ""
fi

jq -n --arg c "$context" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
exit 0
