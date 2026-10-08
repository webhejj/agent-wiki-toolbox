#!/usr/bin/env bash
# Keep a published wiki current: when the agent stops, rebuild the release if a note is newer than it.
#
# Why Stop: it is the one point at which the agent is done with a batch of edits. PostToolUse would
# publish half-finished work after every write, and SessionEnd would leave a wiki stale for as long as
# a session stays open. Stop fires after every turn, not once a session, which is why the staleness
# test and the lock live in `awt site publish --if-stale`: a turn that wrote nothing costs one process
# start, and one that did triggers one build.
#
# Never a first publish. `--if-stale` does nothing for a wiki with no release for its target, so a
# project opts in by publishing once by hand; a hook is not the place to pick an address.
#
# The build runs in the background so the hook returns at once, and its output goes to a log under
# the temp directory named for the project, since nothing is watching it: a build that fails
# otherwise fails silently, and is retried at the next stop until it is fixed.
#
# Which wikis: the ones the session touched, as wiki-docs-touch.sh recorded them, because a session
# rooted above several projects edits their wikis from outside all of them, and its project directory
# is no wiki at all. With no record, the project directory, as before the record was read: a wiki
# edited by hand or by another process while the session sat in it still gets published.
#
# Runs beside wiki-docs-stop.sh, not after it, so a note that script reformats on the way out can be
# newer than the release this one builds; the next stop publishes it. Fails open, like that script.
# Bash 3.2.
set -u

input=$(cat 2>/dev/null || true)
session=""
command -v jq >/dev/null 2>&1 && session=$(jq -r '.session_id // ""' <<<"$input" 2>/dev/null)

roots=""
state="${TMPDIR:-/tmp}/wiki-docs-${session:-nosession}"
[[ -n "$session" && -s "$state.touched" ]] && roots=$(sort -u "$state.touched" 2>/dev/null)
[[ -n "$roots" ]] || roots="${CLAUDE_PROJECT_DIR:-}"
[[ -n "$roots" ]] || exit 0

plugin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || exit 0
awt="$plugin/bin/awt"
if [[ ! -x "$awt" ]]; then
  awt=$(command -v awt 2>/dev/null) || exit 0
fi

while IFS= read -r dir; do
  [[ -n "$dir" && -f "$dir/awt.config.mjs" ]] || continue
  log="${TMPDIR:-/tmp}/awt-publish-$(printf '%s' "$dir" | cksum | cut -d' ' -f1).log"
  ( cd "$dir" && "$awt" site publish --if-stale >"$log" 2>&1 ) </dev/null >/dev/null 2>&1 &
done <<<"$roots"
exit 0
