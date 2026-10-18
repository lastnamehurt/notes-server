#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT
prefix="$SB/install with spaces"
bash "$ROOT/scripts/install-cli.sh" --prefix "$prefix"
[[ -x "$prefix/bin/note" && -x "$prefix/bin/notes" ]]
"$prefix/bin/notes" --help | grep -q 'note sync'
bash "$ROOT/scripts/install-cli.sh" --prefix "$prefix"
mkdir -p "$SB/collision/bin"
printf 'existing command\n' > "$SB/collision/bin/note"
if bash "$ROOT/scripts/install-cli.sh" --prefix "$SB/collision"; then exit 1; fi
[[ "$(cat "$SB/collision/bin/note")" == 'existing command' && ! -e "$SB/collision/bin/notes" ]]
bash "$ROOT/scripts/install-cli.sh" --prefix "$SB/collision" --force
[[ -L "$SB/collision/bin/note" && -L "$SB/collision/bin/notes" ]]
git init -q -b main "$SB/data"
git -C "$SB/data" config user.name Test
git -C "$SB/data" config user.email test@example.invalid
# Capture into an empty notes clone creates inbox and commits locally.
NOTES_DIR="$SB/data" "$prefix/bin/notes" --no-push 'A portable note'
NOTES_DIR="$SB/data" "$prefix/bin/note" show portable | grep -q 'A portable note'
mkdir -p "$SB/data/goals"
printf '# Run a 5k\n\n- [ ] Follow the training plan\n' > "$SB/data/goals/run.md"
git -C "$SB/data" add goals/run.md
git -C "$SB/data" commit -q -m 'Add app-style goal'
[[ "$(NOTES_DIR="$SB/data" "$prefix/bin/notes" ls goals --ids)" == 'goals/run.md' ]]
[[ "$(NOTES_DIR="$SB/data" "$prefix/bin/note" find training --ids)" == 'goals/run.md' ]]
NOTES_DIR="$SB/data" "$prefix/bin/notes" show goals/run.md | grep -q 'Run a 5k'
# One-step setup: the installer clones the notes repository when it's missing, and leaves it alone after.
git clone -q --bare "$SB/data" "$SB/remote.git"
out=$(NOTES_DIR="$SB/fresh" bash "$ROOT/scripts/install-cli.sh" --prefix "$prefix" --notes-repo "$SB/remote.git" --no-shell)
grep -q "Cloned" <<<"$out"
[[ -f "$SB/fresh/goals/run.md" ]]
out=$(NOTES_DIR="$SB/fresh" bash "$ROOT/scripts/install-cli.sh" --prefix "$prefix" --notes-repo "$SB/remote.git" --no-shell)
grep -q "Using your notes in $SB/fresh" <<<"$out"
# A non-Git folder in the way is reported, never overwritten; nothing is asked without a terminal.
mkdir -p "$SB/occupied"; printf 'keep me\n' > "$SB/occupied/file"
out=$(NOTES_DIR="$SB/occupied" bash "$ROOT/scripts/install-cli.sh" --prefix "$prefix" --notes-repo "$SB/remote.git" --no-shell </dev/null)
grep -q "isn't a Git clone" <<<"$out"
[[ "$(cat "$SB/occupied/file")" == 'keep me' && ! -d "$SB/occupied/.git" ]]
out=$(NOTES_DIR="$SB/none" bash "$ROOT/scripts/install-cli.sh" --prefix "$prefix" --no-shell </dev/null)
grep -q -- "--notes-repo OWNER/REPO" <<<"$out"
[[ ! -e "$SB/none" ]]
echo 'Passed installer, alias, collision protection, empty-clone capture, and app goals checks.'
