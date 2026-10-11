#!/usr/bin/env bash
# Contract test for the browsing commands: ls, find, show, edit, rm, pick.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NOTE="$ROOT/bin/note"
SB=$(mktemp -d); trap 'rm -rf "$SB"' EXIT
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1: $2"; fail=$((fail+1)); }

git init -q --bare -b main "$SB/origin.git"
git clone -q "$SB/origin.git" "$SB/n" 2>/dev/null
N="$SB/n"
git -C "$N" config user.email t@t; git -C "$N" config user.name t
git -C "$N" config core.hooksPath "$ROOT/cli/hooks"; git -C "$N" checkout -q -b main 2>/dev/null
mkdir -p "$N/inbox/proj" "$N/runbooks" "$N/bin"
printf -- '---\ntitle: Kafka retries\ndate: 2026-10-01\ntags: [kafka, ops]\n---\n\nUse exponential backoff. Cap at five tries.\n' > "$N/inbox/kafka-retries.md"
printf -- '---\ntitle: "Deploy runbook"\ndate: 2026-10-02\ntags: [ci]\n---\n\nRun the deploy job, then check backoff metrics.\n' > "$N/runbooks/deploy.md"
printf -- '---\ntitle: Zebra facts\ndate: 2026-10-03\n---\n\nzebras are striped\n' > "$N/inbox/zebra.md"
printf 'plain note about rollbacks, no frontmatter\n' > "$N/inbox/proj/rollbacks.md"
git -C "$N" add -A; git -C "$N" commit -q -m seed; git -C "$N" push -q origin HEAD 2>/dev/null

run() { NOTES_DIR="$N" "$NOTE" "$@" </dev/null 2>&1; }       # no terminal on stdin
rc()  { NOTES_DIR="$N" "$NOTE" "$@" </dev/null >/dev/null 2>&1; echo $?; }

# ---- ls
ids=$(run ls --ids)
[ "$(echo "$ids" | head -1)" = "inbox/proj/rollbacks.md" ] && ok "ls puts the newest first (undated notes use their commit date)" || bad "ls order" "$ids"
[ "$(echo "$ids" | sed -n 2,4p | tr '\n' ' ')" = "inbox/zebra.md runbooks/deploy.md inbox/kafka-retries.md " ] && ok "ls orders dated notes by their date" || bad "ls dated order" "$ids"
[ "$(run ls -n 2 --ids | wc -l | tr -d ' ')" = 2 ] && ok "ls -n limits" || bad "ls -n" ""
[ "$(run ls -t kafka --ids)" = "inbox/kafka-retries.md" ] && ok "ls -t filters by tag" || bad "ls -t" "$(run ls -t kafka --ids)"
[ "$(run ls runbooks --ids)" = "runbooks/deploy.md" ] && ok "ls <folder> filters by folder" || bad "ls folder" "$(run ls runbooks --ids)"
out=$(run ls -n 5)
echo "$out" | grep -q 'Deploy runbook' && echo "$out" | grep -q '2026-10-02' && echo "$out" | grep -q '\[ci\]' && ok "ls shows date, id, title and tags" || bad "ls columns" "$out"

# ---- find
out=$(run find backoff)
echo "$out" | grep -q 'inbox/kafka-retries.md' && echo "$out" | grep -q 'runbooks/deploy.md' && ok "find matches content across folders" || bad "find" "$out"
[ "$(run find backoff -t kafka --ids)" = "inbox/kafka-retries.md" ] && ok "find -t narrows" || bad "find -t" ""
out=$(run find zzznothing); r=$(rc find zzznothing)
[ "$r" = 0 ] && echo "$out" | grep -qi 'no notes' && ok "find with no match says so and exits 0" || bad "find none" "rc=$r $out"
[ "$(run find exponential tries --ids)" = "inbox/kafka-retries.md" ] && ok "find needs every word" || bad "find AND" ""

# ---- show
out=$(run show kafka)
echo "$out" | grep -q 'exponential backoff' && ok "show resolves a unique fragment" || bad "show fragment" "$out"
echo "$(run show runbooks/deploy.md)" | grep -q 'deploy job' && ok "show takes a full id" || bad "show id" ""
out=$(run show o); r=$(rc show o)
[ "$r" = 1 ] && echo "$out" | grep -qi 'more than one' && echo "$out" | grep -q 'inbox/' && ok "an ambiguous fragment lists candidates and fails" || bad "ambiguous" "rc=$r $out"
r=$(rc show nosuchnote); [ "$r" = 1 ] && ok "show of nothing fails" || bad "show none" "rc=$r"

# ---- edit
cat > "$SB/ed-append" <<'E'
#!/usr/bin/env bash
printf 'edited by test\n' >> "$1"
E
cat > "$SB/ed-noop" <<'E'
#!/usr/bin/env bash
exit 0
E
cat > "$SB/ed-secret" <<'E'
#!/usr/bin/env bash
printf '%s\n' "tok""en = abcdefghij""klmnop1234" >> "$1"
E
chmod +x "$SB"/ed-*
out=$(EDITOR="$SB/ed-append" run edit kafka); r=$?
[ $r = 0 ] && grep -q 'edited by test' "$N/inbox/kafka-retries.md" && [ "$(git -C "$N" log -1 --format=%s)" = "note: edit Kafka retries" ] \
  && [ "$(git --git-dir="$SB/origin.git" rev-parse main)" = "$(git -C "$N" rev-parse HEAD)" ] && ok "edit commits and pushes a change" || bad "edit" "rc=$r $out"
before=$(git -C "$N" rev-parse HEAD)
out=$(EDITOR="$SB/ed-noop" run edit kafka)
[ "$(git -C "$N" rev-parse HEAD)" = "$before" ] && echo "$out" | grep -qi 'no changes' && ok "edit with no change commits nothing" || bad "edit noop" "$out"
sum=$(shasum "$N/runbooks/deploy.md")
out=$(EDITOR="$SB/ed-secret" run edit deploy); r=$?
[ $r != 0 ] && [ "$(shasum "$N/runbooks/deploy.md")" = "$sum" ] && [ "$(git -C "$N" rev-parse HEAD)" = "$before" ] && git -C "$N" diff --quiet && ok "the secret hook refuses an edit and the note is restored" || bad "edit hook" "rc=$r $out"
r=$(env -u EDITOR -u VISUAL NOTES_DIR="$N" "$NOTE" edit kafka </dev/null >/dev/null 2>&1; echo $?)
[ "$r" = 3 ] && ok "edit with no editor and no terminal refuses (exit 3)" || bad "edit tty" "rc=$r"

# ---- rm
r=$(rc rm zebra); [ "$r" = 3 ] && [ -f "$N/inbox/zebra.md" ] && ok "rm without a terminal or -y refuses (exit 3)" || bad "rm refuse" "rc=$r"
out=$(run rm -y zebra); r=$?
[ $r = 0 ] && [ ! -e "$N/inbox/zebra.md" ] && [ "$(git --git-dir="$SB/origin.git" rev-parse main)" = "$(git -C "$N" rev-parse HEAD)" ] && ok "rm -y deletes, commits and pushes" || bad "rm -y" "rc=$r $out"
echo "$out" | grep -q 'revert' && ok "rm says how to undo it" || bad "rm undo" "$out"
r=$(rc rm -y o); [ "$r" = 1 ] && ok "rm refuses an ambiguous fragment (one note per call)" || bad "rm ambiguous" "rc=$r"

# ---- pick and the fzf feed
r=$(rc pick); [ "$r" = 3 ] && ok "pick without a terminal refuses (exit 3)" || bad "pick tty" "rc=$r"
out=$(run ls --fzf)
echo "$out" | head -1 | awk -F'\t' 'NF>=2 {f=1} END{exit !f}' && echo "$out" | grep -q 'exponential' && ok "the fzf feed is id<TAB>display and includes body text to search" || bad "fzf feed" "$out"

# ---- capture still works, quoted text that starts with a command word included
NOTES_DIR="$N" "$NOTE" --no-push "find the thing" >/dev/null 2>&1
ls "$N/inbox" | grep -q 'find-the-thing' && ok 'note "find the thing" still saves a note' || bad "capture" "$(ls "$N/inbox")"

# ---- empty input is never saved (bare `note` with an empty stdin used to commit and push a blank note)
before=$(git -C "$N" rev-parse HEAD); files_before=$(find "$N/inbox" -type f | wc -l)
r=$(NOTES_DIR="$N" "$NOTE" </dev/null >/dev/null 2>&1; echo $?)
[ "$r" = 2 ] && [ "$(git -C "$N" rev-parse HEAD)" = "$before" ] && [ "$(find "$N/inbox" -type f | wc -l)" = "$files_before" ] && ok "empty stdin saves nothing and exits 2" || bad "empty stdin" "rc=$r"
r=$(printf '  \n\n' | NOTES_DIR="$N" "$NOTE" >/dev/null 2>&1; echo $?)
[ "$r" = 2 ] && [ "$(git -C "$N" rev-parse HEAD)" = "$before" ] && ok "whitespace-only stdin saves nothing" || bad "blank stdin" "rc=$r"
r=$(NOTES_DIR="$N" "$NOTE" "   " </dev/null >/dev/null 2>&1; echo $?)
[ "$r" = 2 ] && [ "$(git -C "$N" rev-parse HEAD)" = "$before" ] && ok "a blank argument saves nothing" || bad "blank arg" "rc=$r"

# ---- natural verbs are aliases, and a mistyped command is never saved as a note
before=$(git -C "$N" rev-parse HEAD); files_before=$(find "$N/inbox" -type f | wc -l)
[ "$(run view kafka | grep -c 'exponential backoff')" = 1 ] && ok "view is show" || bad "alias view" ""
[ "$(run open kafka | grep -c 'exponential backoff')" = 1 ] && ok "open is show" || bad "alias open" ""
[ "$(run list -n 1 --ids | wc -l | tr -d ' ')" = 1 ] && ok "list is ls" || bad "alias list" ""
[ "$(run search backoff --ids | head -1)" = "runbooks/deploy.md" ] || [ "$(run search backoff --ids | wc -l | tr -d ' ')" = 2 ] && ok "search is find" || bad "alias search" ""
printf 'doomed\n' > "$N/inbox/doomed.md"; git -C "$N" add -A; git -C "$N" commit -q -m doomed; git -C "$N" push -q origin HEAD 2>/dev/null
out=$(run remove -y doomed); [ ! -e "$N/inbox/doomed.md" ] && ok "remove is rm" || bad "alias remove" "$out"
printf 'doomed2\n' > "$N/inbox/doomed2.md"; git -C "$N" add -A; git -C "$N" commit -q -m doomed2; git -C "$N" push -q origin HEAD 2>/dev/null
out=$(run delete -y doomed2); [ ! -e "$N/inbox/doomed2.md" ] && ok "delete is rm" || bad "alias delete" "$out"

before=$(git -C "$N" rev-parse HEAD); files_before=$(find "$N/inbox" -type f | wc -l)
out=$(run how inbox/kafka-retries.md); r=$?
[ $r = 2 ] && echo "$out" | grep -q 'existing note' && [ "$(git -C "$N" rev-parse HEAD)" = "$before" ] && [ "$(find "$N/inbox" -type f | wc -l)" = "$files_before" ] \
  && ok "an unknown word followed by a note id is refused, not saved" || bad "mistyped command" "rc=$r $out"
out=$(run frobnicate "$N/inbox/kafka-retries.md"); r=$?
[ $r = 2 ] && ok "an absolute path to a note is refused too" || bad "abs path" "rc=$r $out"
NOTES_DIR="$N" "$NOTE" --no-push -- how inbox/kafka-retries.md </dev/null >/dev/null 2>&1
ls "$N/inbox" | grep -q 'how-inbox-kafka' && ok "-- is the escape hatch: it saves the text anyway" || bad "escape hatch" "$(ls "$N/inbox")"
NOTES_DIR="$N" "$NOTE" --no-push "see inbox/kafka-retries.md for details" </dev/null >/dev/null 2>&1
ls "$N/inbox" | grep -q 'see-inbox-kafka' && ok "one quoted sentence that mentions a path still saves" || bad "quoted path" "$(ls "$N/inbox")"

# ---- ambiguous fragments: backend lists every match (the terminal picker uses it)
m=$(NOTES_DIR="$N" python3 "$ROOT/mcp/note-mcp" matches o </dev/null | wc -l | tr -d ' ')
[ "$m" -ge 3 ] && ok "matches lists every candidate" || bad "matches" "$m"
[ "$(NOTES_DIR="$N" python3 "$ROOT/mcp/note-mcp" matches kafka-retries.md </dev/null)" = "inbox/kafka-retries.md" ] && ok "matches of a unique fragment is that one note" || bad "matches unique" ""
[ -z "$(NOTES_DIR="$N" python3 "$ROOT/mcp/note-mcp" matches zzzzzz </dev/null)" ] && ok "matches of nothing is empty" || bad "matches none" ""

echo; echo "passed $pass, failed $fail"; [ "$fail" -eq 0 ]
