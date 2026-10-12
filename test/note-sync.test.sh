#!/usr/bin/env bash
# Contract test for `note sync`. Two clones of one bare origin stand in for two machines.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NOTE="$ROOT/bin/note"
SB=$(mktemp -d); trap 'rm -rf "$SB"' EXIT
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1: $2"; fail=$((fail+1)); }

mkrepos() {  # fresh origin + clones A and B, one seeded commit on main
  rm -rf "$SB"/*
  git init -q --bare -b main "$SB/origin.git"
  for m in A B; do
    git clone -q "$SB/origin.git" "$SB/$m" 2>/dev/null
    git -C "$SB/$m" config user.email t@t; git -C "$SB/$m" config user.name t
    git -C "$SB/$m" checkout -q -b main 2>/dev/null
  done
  mkdir -p "$SB/A/inbox"; printf 'base line\n' > "$SB/A/inbox/shared.md"
  git -C "$SB/A" add -A; git -C "$SB/A" commit -q -m seed; git -C "$SB/A" push -q origin HEAD
  git -C "$SB/B" pull -q origin main 2>/dev/null
}
sync_in() { NOTES_DIR="$SB/$1" "$NOTE" sync 2>&1; }
head_of() { git -C "$SB/$1" rev-parse HEAD; }
origin_head() { git --git-dir="$SB/origin.git" rev-parse main; }
commit_in() {  # commit_in <machine> <file> <content> <msg>
  mkdir -p "$(dirname "$SB/$1/$2")"; printf '%s\n' "$3" > "$SB/$1/$2"
  git -C "$SB/$1" add -A; git -C "$SB/$1" commit -q -m "$4"
}

mkrepos
out=$(sync_in A); rc=$?
[ $rc = 0 ] && echo "$out" | grep -qi 'already in sync' && ok "nothing to do says so" || bad "in sync" "rc=$rc $out"

mkrepos; commit_in A inbox/a.md "from A" "a"
out=$(sync_in A); rc=$?
[ $rc = 0 ] && [ "$(origin_head)" = "$(head_of A)" ] && echo "$out" | grep -qi 'pushed 1' && ok "an unpushed commit is pushed" || bad "push pending" "rc=$rc $out"

mkrepos; commit_in B inbox/b.md "from B" "b"; git -C "$SB/B" push -q origin HEAD
out=$(sync_in A); rc=$?
[ $rc = 0 ] && [ -f "$SB/A/inbox/b.md" ] && echo "$out" | grep -qi 'pulled 1' && ok "a note pushed from another machine is pulled" || bad "pull" "rc=$rc $out"

mkrepos; commit_in A inbox/a.md "from A" "a"; commit_in B inbox/b.md "from B" "b"; git -C "$SB/B" push -q origin HEAD
out=$(sync_in A); rc=$?
[ $rc = 0 ] && [ -f "$SB/A/inbox/b.md" ] && [ "$(origin_head)" = "$(head_of A)" ] && git --git-dir="$SB/origin.git" cat-file -e main:inbox/a.md \
  && ok "both sides moved: pulled and pushed, origin has both" || bad "both" "rc=$rc $out"

mkrepos; commit_in B inbox/b.md "from B" "b"; git -C "$SB/B" push -q origin HEAD
printf 'unsaved scratch\n' > "$SB/A/inbox/scratch.md"; printf 'edited\n' >> "$SB/A/inbox/shared.md"
out=$(sync_in A); rc=$?
[ $rc = 0 ] && [ -f "$SB/A/inbox/b.md" ] && grep -q 'unsaved scratch' "$SB/A/inbox/scratch.md" && grep -q '^edited$' "$SB/A/inbox/shared.md" \
  && ok "uncommitted work survives a sync" || bad "dirty tree" "rc=$rc $out"

mkrepos; commit_in A inbox/shared.md "A's version" "a edit"; commit_in B inbox/shared.md "B's version" "b edit"; git -C "$SB/B" push -q origin HEAD
a_before=$(head_of A); o_before=$(origin_head)
out=$(sync_in A); rc=$?
[ $rc != 0 ] && echo "$out" | grep -qi 'conflict' && ok "a conflict is reported and fails" || bad "conflict report" "rc=$rc $out"
[ ! -d "$SB/A/.git/rebase-merge" ] && [ ! -d "$SB/A/.git/rebase-apply" ] && [ "$(head_of A)" = "$a_before" ] && [ "$(origin_head)" = "$o_before" ] \
  && git -C "$SB/A" diff --quiet && grep -q "A's version" "$SB/A/inbox/shared.md" \
  && ok "after a conflict nothing is half-done: no rebase, commit and file intact, origin untouched" || bad "conflict state" "$(git -C "$SB/A" status --short | head -3)"

mkrepos; commit_in A inbox/a.md "from A" "a"
git -C "$SB/A" remote set-url origin "$SB/does-not-exist.git"
a_before=$(head_of A)
out=$(sync_in A); rc=$?
[ $rc != 0 ] && [ "$(head_of A)" = "$a_before" ] && echo "$out" | grep -qi 'origin' && ok "an unreachable origin fails cleanly and changes nothing" || bad "unreachable" "rc=$rc $out"

# A rejected push must not be reported as a successful save.
mkrepos
git -C "$SB/A" remote set-url origin "$SB/missing-origin.git"
out=$(NOTES_DIR="$SB/A" "$NOTE" "offline note" 2>&1); rc=$?
[ "$rc" -ne 0 ] && echo "$out" | grep -qi 'push failed' && git -C "$SB/A" log -1 --format=%s | grep -q 'offline note' \
  && ok "failed push returns nonzero while preserving local commit" || bad "push failure" "rc=$rc $out"

# Dirty changes on the same file as a remote update must never disappear.
mkrepos; commit_in B inbox/shared.md "remote update" "remote edit"; git -C "$SB/B" push -q origin HEAD
printf 'local unsaved change\\n' > "$SB/A/inbox/shared.md"
out=$(sync_in A); rc=$?
grep -q 'local unsaved change' "$SB/A/inbox/shared.md" \
  && { [ "$rc" -ne 0 ] || grep -q 'remote update' "$SB/A/inbox/shared.md"; } \
  && ok "dirty work survives sync whether Git merges or reports a conflict" || bad "dirty conflict" "rc=$rc $out"

mkrepos
NOTES_DIR="$SB/A" "$NOTE" --no-push -- sync >/dev/null 2>&1
ls "$SB/A/inbox" | grep -q 'sync' && ok "note -- sync still saves a note whose text is 'sync'" || bad "literal sync" "$(ls "$SB/A/inbox")"

echo; echo "passed $pass, failed $fail"; [ "$fail" -eq 0 ]
