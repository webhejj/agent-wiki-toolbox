#!/usr/bin/env bash
# Deliver what a structural verb would not do, and put the index back in step.
#
# The four verbs that move notes -- `move`, `rename`, `split_by_heading` and
# `merge_files` -- each return a report carrying two lists:
#
#   skipped     files that changed underneath the verb, so it refused to overwrite
#               them; re-running finishes what it left
#   unresolved  links it would not guess at -- an ambiguous stem, a stub naming no
#               single child, a relative link that already pointed at nothing
#
# Both are in the tool result already. "Read the return value" is a rule the agent
# follows or does not, and the cost of not following it is a rewrite that looks
# complete. This hook makes the two lists arrive on their own, as
# `additionalContext`, which `PostToolUse` was measured to deliver.
#
# The same run regenerates the listing, because each of these four changes the set
# of notes or the paths they sit at, and the index table stops matching the wiki
# the moment one lands. A regenerated index is appended to the session's touch
# record, so the Stop hook formats it like anything else the session wrote rather
# than leaving `awt fmt --dry-run` dirty.
#
# A dry run is a preview the agent asked for: the lists still arrive, nothing is
# written, and the index is left alone.
#
# Fails open by design: anything wrong here lets the session continue. Bash 3.2,
# which is what macOS ships, so no mapfile and no associative arrays.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input" 2>/dev/null)
session=$(jq -r '.session_id // "nosession"' <<<"$input" 2>/dev/null)
cwd=$(jq -r '.cwd // ""' <<<"$input" 2>/dev/null)

# The matcher in hooks.json names these four already. Checked again here because a
# matcher is a regular expression over a scoped name, and `rename` is a prefix of
# `rename_tag`.
case "$tool" in
  mcp__*agent-wiki-toolbox__move) verb="move" ;;
  mcp__*agent-wiki-toolbox__rename) verb="rename" ;;
  mcp__*agent-wiki-toolbox__split_by_heading) verb="split_by_heading" ;;
  mcp__*agent-wiki-toolbox__merge_files) verb="merge_files" ;;
  *) exit 0 ;;
esac

# `tool_response` is an array of MCP content blocks -- measured, not read -- and the
# verb's report is the JSON in the first text block. The other two forms are what
# the same value looks like if it is ever handed over unwrapped; costing four lines
# is cheaper than a hook that goes silent on a shape change.
report=$(jq -r '
  def blocks:
    if type == "array" then .[]
    elif type == "object" and (.content | type) == "array" then .content[]
    else empty end;
  [.tool_response | blocks | select(.type == "text") | .text] as $text
  | if ($text | length) > 0 then $text[0]
    elif (.tool_response | type) == "object" then (.tool_response | tojson)
    elif (.tool_response | type) == "string" then .tool_response
    else "" end' <<<"$input" 2>/dev/null)

jq -e 'has("verb")' >/dev/null 2>&1 <<<"$report" || exit 0

dry=$(jq -r '.dryRun // false' <<<"$report" 2>/dev/null)

# The same walk up to the project marker every awt command does, and the same one
# the guard and the touch record do.
dir="${cwd:-$PWD}"
root=""
while [[ -n "$dir" && "$dir" != "/" ]]; do
  [[ -f "$dir/awt.config.mjs" ]] && { root="$dir"; break; }
  dir="${dir%/*}"
done
[[ -n "$root" ]] || exit 0

report_text=""
add() { report_text="$report_text$1"$'\n'; }

# A list, truncated. Twenty lines is enough to act on; the whole of a hundred-link
# rewrite is a wall the agent reads past.
LIMIT=20
render() {
  local lines count
  lines=$(jq -r "$1" <<<"$report" 2>/dev/null) || return 0
  [[ -n "$lines" ]] || return 0
  count=$(printf '%s\n' "$lines" | wc -l | tr -d ' ')
  printf '%s\n' "$lines" | head -"$LIMIT"
  (( count > LIMIT )) && printf '  … and %s more\n' "$(( count - LIMIT ))"
  return 0
}

unresolved=$(render '
  .unresolved[]
  | "  " + (.from // .path // "?") + ":" + ((.line // 0) | tostring)
    + "  " + (.target // "?") + " — " + (.reason // "no reason given")
    + (if ((.candidates // []) | length) > 0
       then " (candidates: " + ((.candidates // []) | join(", ")) + ")"
       else "" end)')

skipped=$(render '.skipped[] | "  " + (.path // "?") + " — " + (.reason // "no reason given")')

if [[ -n "$unresolved" ]]; then
  add "\`$verb\` left links it would not guess at:"
  add ""
  add "$unresolved"
  add ""
  add "Each is a link that still points where it did. Decide where it should point and"
  add "write it, or disambiguate the target — the verb will not choose for you."
  add ""
fi

if [[ -n "$skipped" ]]; then
  add "\`$verb\` refused to overwrite files that had changed underneath it:"
  add ""
  add "$skipped"
  add ""
  add "Nothing was lost and nothing was half-written. Re-run the verb to finish the rest."
  add ""
fi

# The index. Not on a dry run, which wrote nothing for it to fall out of step with.
if [[ "$dry" != "true" ]]; then
  # The plugin's own binary, not whatever a shell profile put on PATH.
  plugin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || plugin=""
  awt="$plugin/bin/awt"
  [[ -x "$awt" ]] || awt=$(command -v awt 2>/dev/null || true)

  if [[ -n "$awt" && -x "$awt" ]] && listing=$(cd "$root" && "$awt" listing --json 2>/dev/null); then
    written=$(jq -r '(.changed // [])[]' <<<"$listing" 2>/dev/null)
    if [[ -n "$written" ]]; then
      add "The index listing was regenerated, so its rows match the wiki again:"
      add ""
      add "$(printf '%s\n' "$written" | sed 's/^/  /')"
      add ""

      # rootDir names the wiki's home, `wiki` when unsaid; `notes` is a fixed name
      # inside it. Same cache the touch record keeps, so whichever hook runs first
      # pays for it.
      cache="${TMPDIR:-/tmp}/wiki-docs-notesdir${root//\//_}"
      if [[ -f "$cache" ]]; then
        notes=$(<"$cache")
      else
        rootdir=$(grep -oE "rootDir:[[:space:]]*['\"][^'\"]+['\"]" "$root/awt.config.mjs" 2>/dev/null |
                  head -1 | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/")
        notes="$root/${rootdir:-wiki}/notes"
        printf '%s\n' "$notes" > "$cache" 2>/dev/null || true
      fi

      # Into the touch record, so the file this hook wrote is formatted at Stop by
      # the machinery that formats everything else the session wrote.
      state="${TMPDIR:-/tmp}/wiki-docs-${session}"
      grep -qxF -- "$root" "$state.touched" 2>/dev/null ||
        printf '%s\n' "$root" >> "$state.touched" 2>/dev/null || true
      printf '%s\n' "$written" | while IFS= read -r f; do
        [[ -n "$f" ]] && printf '%s\n' "$notes/$f" >> "$state.files" 2>/dev/null
      done
    fi
  fi
fi

[[ -n "${report_text//[[:space:]]/}" ]] || exit 0

jq -n --arg c "$report_text" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
exit 0
