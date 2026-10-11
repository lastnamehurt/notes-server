#!/usr/bin/env bash
# Contract test for mcp/note-mcp. Uses a fake `note`, so nothing is committed or pushed.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SERVER="$ROOT/mcp/note-mcp"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/note" <<'F'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_ARGS"
[ "${FAKE_FAIL:-0}" = 1 ] && { echo "push rejected" >&2; exit 1; }
echo "saved inbox/fake.md"
F
chmod +x "$TMP/note"
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1: $2"; fail=$((fail+1)); }

rpc() { # rpc <json lines...>  ->  server stdout
  printf '%s\n' "$@" | NOTE_BIN="$TMP/note" FAKE_ARGS="$TMP/args" timeout 10 "$SERVER"
}
J() { command jq -c "$@"; }

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
NOTIF='{"jsonrpc":"2.0","method":"notifications/initialized"}'
LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

out=$(rpc "$INIT" "$NOTIF" "$LIST")
[ "$(echo "$out" | wc -l | tr -d ' ')" = 2 ] && ok "one response per request, none for the notification" || bad "responses" "$out"
echo "$out" | sed -n 1p | command jq -e '.id==1 and .result.capabilities.tools and .result.serverInfo.name' >/dev/null \
  && ok "initialize advertises tools" || bad "initialize" "$out"
echo "$out" | sed -n 2p | command jq -e '.result.tools[0].name=="save_note" and (.result.tools[0].description|test("pushed")) and (.result.tools[0].inputSchema.required==["text"])' >/dev/null \
  && ok "save_note is listed, says it pushes, requires text" || bad "tools/list" "$out"

CALL='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"save_note","arguments":{"text":"hello world","title":"A title"}}}'
out=$(rpc "$INIT" "$CALL" | sed -n 2p)
echo "$out" | command jq -e '.result.isError==false and (.result.content[0].text|test("saved"))' >/dev/null \
  && ok "call succeeds and returns the note output" || bad "call" "$out"
[ "$(cat "$TMP/args")" = "$(printf -- '-t\nA title\n--\nhello world')" ] && ok "title and text reach note as -t <title> -- <text>" || bad "args" "$(cat "$TMP/args")"

CALL='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"save_note","arguments":{"text":"--no-push sneaky"}}}'
rpc "$INIT" "$CALL" >/dev/null
[ "$(cat "$TMP/args")" = "$(printf -- '--\n--no-push sneaky')" ] && ok "text that looks like a flag is passed after --" || bad "flag injection" "$(cat "$TMP/args")"

out=$(FAKE_FAIL=1 rpc "$INIT" "$CALL" | sed -n 2p)
echo "$out" | command jq -e '.result.isError==true and (.result.content[0].text|test("push rejected"))' >/dev/null \
  && ok "a failing note is reported as isError with its message" || bad "failure" "$out"

CALL='{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"save_note","arguments":{}}}'
out=$(rpc "$INIT" "$CALL" | sed -n 2p)
echo "$out" | command jq -e '.result.isError==true' >/dev/null && ok "missing text is an error, not a crash" || bad "missing text" "$out"

out=$(rpc "$INIT" '{"jsonrpc":"2.0","id":6,"method":"nope"}' | sed -n 2p)
echo "$out" | command jq -e '.error.code==-32601' >/dev/null && ok "unknown method gets -32601" || bad "unknown method" "$out"


# ---- CRUD against a sandbox repo with a real (bare) origin; the real hook is used ----
SB=$(mktemp -d); trap 'rm -rf "$TMP" "$SB"' EXIT
git init -q --bare "$SB/origin.git"
git clone -q "$SB/origin.git" "$SB/notes" 2>/dev/null
N="$SB/notes"
git -C "$N" config user.email t@t; git -C "$N" config user.name t
git -C "$N" config core.hooksPath "$ROOT/cli/hooks"
mkdir -p "$N/inbox/proj" "$N/runbooks" "$N/bin"
printf -- '---\ntitle: Kafka retries\ndate: 2026-10-01\nsource: local\ntags: [kafka, ops]\n---\n\nUse exponential backoff. Cap at five tries.\n' > "$N/inbox/kafka-retries.md"
printf -- '---\ntitle: Deploy runbook\ndate: 2026-10-02\nsource: local\ntags: [ci]\n---\n\nRun the deploy job, then check backoff metrics.\n' > "$N/runbooks/deploy.md"
printf 'plain note with no frontmatter about rollbacks\n' > "$N/inbox/proj/rollbacks.md"
printf -- '---\ntitle: "Quoted title here"\ndate: 2026-10-03\ntags: ["q1", q2]\n---\n\nbody about zebras\n' > "$N/inbox/quoted.md"
echo '#!/bin/sh' > "$N/bin/secret-tool"
git -C "$N" add -A && git -C "$N" commit -q -m seed && git -C "$N" push -q origin HEAD 2>/dev/null
origin_count() { git --git-dir="$SB/origin.git" rev-list --count HEAD 2>/dev/null || echo 0; }
local_count()  { git -C "$N" rev-list --count HEAD; }

call() { # call <tool> <args-json>  ->  the tools/call response
  local req; req=$(command jq -nc --arg n "$1" --argjson a "$2" '{jsonrpc:"2.0",id:9,method:"tools/call",params:{name:$n,arguments:$a}}')
  printf '%s\n' "$INIT" "$req" | NOTES_DIR="$N" timeout 30 "$SERVER" | sed -n 2p
}
text() { command jq -r '.result.content[0].text'; }
is_error() { command jq -e '.result.isError==true' >/dev/null; }
not_error() { command jq -e '.result.isError==false' >/dev/null; }

out=$(printf '%s\n' "$INIT" "$LIST" | NOTES_DIR="$N" "$SERVER" | sed -n 2p)
[ "$(echo "$out" | command jq -r '[.result.tools[].name]|sort|join(",")')" = "delete_note,get_note,list_notes,save_note,search_notes,sync_notes,update_note" ] \
  && ok "all seven tools are listed" || bad "tools/list" "$out"
echo "$out" | command jq -e '.result.tools[]|select(.name=="delete_note")|(.inputSchema.required|index("confirm")) != null' >/dev/null \
  && ok "delete_note requires confirm" || bad "delete schema" "$out"

r=$(call search_notes '{"query":"backoff"}')
t=$(echo "$r" | text)
echo "$r" | not_error && echo "$t" | grep -q 'inbox/kafka-retries.md' && echo "$t" | grep -q 'runbooks/deploy.md' \
  && ok "search finds notes across folders, by relative-path id" || bad "search" "$t"
echo "$t" | grep -q 'Kafka retries' && ok "search shows the title" || bad "search title" "$t"
t=$(call search_notes '{"query":"backoff","tags":["kafka"]}' | text)
echo "$t" | grep -q 'kafka-retries' && ! echo "$t" | grep -q 'deploy.md' && ok "tags narrow the search" || bad "tag filter" "$t"
t=$(call search_notes '{"query":"rollbacks"}' | text)
echo "$t" | grep -q 'inbox/proj/rollbacks.md' && ok "search reaches nested folders and notes without frontmatter" || bad "nested" "$t"
t=$(call search_notes '{"query":"zebras","tags":["q1"]}' | text)
echo "$t" | grep -q '^    Quoted title here$' && echo "$t" | grep -q '\[q1, q2\]' && ok "quotes around frontmatter titles and tags are dropped" || bad "quotes" "$t"
t=$(call search_notes '{"query":"zzzznothing"}' | text)
echo "$t" | grep -qi 'no notes' && ok "an empty result says so" || bad "empty" "$t"
t=$(call search_notes '{}' | text)
echo "$t" | grep -q 'kafka' && echo "$t" | grep -q 'inbox' && ok "no arguments lists tags and folders" || bad "vocabulary" "$t"
! echo "$t" | grep -q 'secret-tool' && ok "files outside the note folders are never listed" || bad "scope" "$t"

r=$(call list_notes '{}'); t=$(echo "$r" | text)
echo "$r" | not_error && echo "$t" | grep -q 'inbox/kafka-retries.md' && echo "$t" | grep -q 'runbooks/deploy.md' && echo "$t" | grep -q 'Kafka retries' \
  && ok "list_notes lists notes with id, date, title" || bad "list_notes" "$t"
first=$(echo "$t" | grep -m1 -E '^  [0-9]{4}-' | awk '{print $2}')
[ "$first" = "inbox/proj/rollbacks.md" ] && ok "list_notes is newest first (undated notes use their commit date)" || bad "list order" "first=$first
$t"
t=$(call list_notes '{"folder":"runbooks"}' | text); echo "$t" | grep -q 'deploy.md' && ! echo "$t" | grep -q 'kafka-retries' && ok "list_notes filters by folder" || bad "list folder" "$t"
t=$(call list_notes '{"tags":["kafka"]}' | text); echo "$t" | grep -q 'kafka-retries' && ! echo "$t" | grep -q 'deploy.md' && ok "list_notes filters by tag" || bad "list tag" "$t"
t=$(call list_notes '{"limit":1}' | text); [ "$(echo "$t" | grep -cE '^  [0-9]{4}-')" = 1 ] && echo "$t" | grep -q 'showing 1' && ok "list_notes honors limit" || bad "list limit" "$t"
call list_notes '{"folder":"bin"}' | is_error && ok "list_notes rejects a folder that is not a note folder" || bad "list bad folder" ""

r=$(call get_note '{"id":"runbooks/deploy.md"}'); t=$(echo "$r" | text)
echo "$r" | not_error && echo "$t" | grep -q 'Run the deploy job' && ok "get_note returns the whole note" || bad "get" "$t"
for evil in '../origin.git/HEAD' '/etc/passwd' 'bin/secret-tool' '.git/config' 'inbox/../bin/secret-tool' 'README.md'; do
  r=$(call get_note "$(command jq -nc --arg i "$evil" '{id:$i}')")
  echo "$r" | is_error && ok "get_note refuses '$evil'" || bad "traversal '$evil'" "$(echo "$r" | text)"
done
call get_note '{"id":"inbox/missing.md"}' | is_error && ok "get_note on a missing id is an error" || bad "missing id" ""

before_l=$(local_count); before_o=$(origin_count)
r=$(call update_note '{"id":"inbox/kafka-retries.md","addition":"Jitter helps too.","reason":"missing case"}'); t=$(echo "$r" | text)
echo "$r" | not_error && grep -q 'Jitter helps too.' "$N/inbox/kafka-retries.md" && grep -q 'Cap at five tries.' "$N/inbox/kafka-retries.md" \
  && ok "update_note appends a paragraph and keeps the rest" || bad "append" "$t"
echo "$t" | grep -q '^+.*Jitter' && ok "update_note returns a diff" || bad "diff" "$t"
[ "$(local_count)" = $((before_l+1)) ] && [ "$(origin_count)" = $((before_o+1)) ] && ok "an update is committed and pushed" || bad "commit/push" "local $(local_count) origin $(origin_count)"

r=$(call update_note '{"id":"inbox/kafka-retries.md","replaces":"five tries","with_text":"six tries","reason":"changed"}')
echo "$r" | not_error && grep -q 'Cap at six tries' "$N/inbox/kafka-retries.md" && ok "replace swaps an exact snippet" || bad "replace" "$(echo "$r" | text)"

printf 'dup dup\n' >> "$N/inbox/proj/rollbacks.md"; git -C "$N" commit -qam dup
c=$(local_count); sum_before=$(shasum "$N/inbox/proj/rollbacks.md")
r=$(call update_note '{"id":"inbox/proj/rollbacks.md","replaces":"dup","with_text":"x","reason":"r"}')
echo "$r" | is_error && [ "$(shasum "$N/inbox/proj/rollbacks.md")" = "$sum_before" ] && [ "$(local_count)" = "$c" ] \
  && ok "a snippet that appears twice is refused and nothing changes" || bad "ambiguous" "$(echo "$r" | text)"
r=$(call update_note '{"id":"inbox/proj/rollbacks.md","replaces":"not present","with_text":"x","reason":"r"}')
echo "$r" | is_error && ok "a snippet that is absent is refused" || bad "absent" "$(echo "$r" | text)"
call update_note '{"id":"inbox/proj/rollbacks.md","reason":"r"}' | is_error && ok "update with no change given is an error" || bad "no change" ""

c=$(local_count); sum_before=$(shasum "$N/runbooks/deploy.md")
# Built from pieces so this file itself never contains something the hook would block.
fake_secret="tok""en = abcdefghij""klmnop1234"
r=$(call update_note "$(command jq -nc --arg a "$fake_secret" '{id:"runbooks/deploy.md",addition:$a,reason:"r"}')"); t=$(echo "$r" | text)
echo "$r" | is_error && echo "$t" | grep -q 'pre-commit' && [ "$(shasum "$N/runbooks/deploy.md")" = "$sum_before" ] && [ "$(local_count)" = "$c" ] \
  && git -C "$N" diff --quiet && git -C "$N" diff --cached --quiet \
  && ok "the secret hook refuses an update and the note is restored" || bad "hook" "$t"

r=$(call delete_note '{"id":"runbooks/deploy.md"}')
echo "$r" | is_error && [ -f "$N/runbooks/deploy.md" ] && ok "delete without confirm is refused" || bad "delete no confirm" "$(echo "$r" | text)"
r=$(call delete_note '{"id":"runbooks/deploy.md","confirm":true}'); t=$(echo "$r" | text)
echo "$r" | not_error && [ ! -e "$N/runbooks/deploy.md" ] && [ "$(git --git-dir="$SB/origin.git" rev-parse HEAD)" = "$(git -C "$N" rev-parse HEAD)" ] \
  && ok "delete with confirm removes, commits and pushes" || bad "delete" "$t"
echo "$t" | grep -q 'revert' && ok "delete says how to undo it" || bad "undo hint" "$t"
call delete_note '{"id":"runbooks/deploy.md","confirm":true}' | is_error && ok "deleting a missing note is an error" || bad "delete missing" ""
call delete_note '{"id":"../origin.git/HEAD","confirm":true}' | is_error && ok "delete refuses a path outside the note folders" || bad "delete traversal" ""
git -C "$N" revert --no-edit HEAD >/dev/null 2>&1 && [ -f "$N/runbooks/deploy.md" ] && ok "the undo it names works" || bad "revert" ""

# sync_notes: drives the real `note sync` against the sandbox
printf 'pending\n' > "$N/inbox/pending.md"; git -C "$N" add -A; git -C "$N" commit -q -m "pending, not pushed"
r=$(call sync_notes '{}'); t=$(echo "$r" | text)
echo "$r" | not_error && echo "$t" | grep -qiE 'pushed [1-9]' && [ "$(git --git-dir="$SB/origin.git" rev-parse HEAD)" = "$(git -C "$N" rev-parse HEAD)" ] \
  && ok "sync_notes pushes commits that are still pending" || bad "sync push" "$t"
r=$(call sync_notes '{}'); echo "$r" | not_error && echo "$r" | text | grep -qi 'already in sync' && ok "sync_notes with nothing to do says so" || bad "sync idle" "$(echo "$r" | text)"
good_url=$(git -C "$N" remote get-url origin); git -C "$N" remote set-url origin "$SB/gone.git"
r=$(call sync_notes '{}'); t=$(echo "$r" | text); git -C "$N" remote set-url origin "$good_url"
echo "$r" | is_error && echo "$t" | grep -qi 'origin' && ok "sync_notes reports an unreachable origin as an error" || bad "sync error" "$t"

echo; echo "passed $pass, failed $fail"; [ "$fail" -eq 0 ]
