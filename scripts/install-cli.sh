#!/usr/bin/env bash
# One step on a new machine: link the note/notes commands, put them on PATH, and clone your notes.
# Install both CLI names without replacing an existing command by default.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
prefix="${HOME}/.local"
force=0
notes_repo=""
skip_notes=0
skip_shell=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || { echo 'install-cli: --prefix needs a directory' >&2; exit 2; }
      prefix="$2"; shift 2 ;;
    --force) force=1; shift ;;
    --notes-repo)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || { echo 'install-cli: --notes-repo needs owner/repo or a Git URL' >&2; exit 2; }
      notes_repo="$2"; shift 2 ;;
    --no-notes) skip_notes=1; shift ;;
    --no-shell) skip_shell=1; shift ;;
    -h|--help)
      echo 'Usage: scripts/install-cli.sh [--prefix DIR] [--force] [--notes-repo OWNER/REPO|GIT-URL] [--no-notes] [--no-shell]'
      echo 'Links note and notes into DIR/bin (default: ~/.local/bin). Keep this checkout.'
      echo 'Then clones your notes repository into $NOTES_DIR (default: ~/notes) if it is not there yet,'
      echo 'asking for OWNER/REPO when run in a terminal, and offers to add DIR/bin to PATH in your shell profile.'
      echo '--force replaces existing command files or symlinks; directories are never replaced.'
      echo '--no-notes skips the notes clone; --no-shell never touches your shell profile.'
      exit 0 ;;
    *) echo "install-cli: unknown option: $1" >&2; exit 2 ;;
  esac
done
for tool in git python3; do
  command -v "$tool" >/dev/null || { echo "install-cli: $tool is required" >&2; exit 1; }
done
mkdir -p "$prefix/bin"
# Check both names before changing either one.
for name in note notes; do
  target="$prefix/bin/$name"
  if [[ -L "$target" && "$(readlink "$target")" == "$ROOT/bin/$name" ]]; then continue; fi
  if [[ -d "$target" && ! -L "$target" ]]; then
    echo "install-cli: $target is a directory; nothing installed" >&2; exit 1
  fi
  if [[ ( -e "$target" || -L "$target" ) && $force -ne 1 ]]; then
    echo "install-cli: $target already exists; use --force to replace it" >&2; exit 1
  fi
done
for name in note notes; do ln -sfn "$ROOT/bin/$name" "$prefix/bin/$name"; done
echo "✓ Installed note and notes in $prefix/bin"

# Questions only when a person is at the terminal; scripts and CI get printed instructions instead.
interactive=0
[[ -t 0 && -t 1 ]] && interactive=1
ask() { local answer; read -r -p "$1" answer || true; printf '%s' "$answer"; }
todo=()

# PATH: offer to add the bin directory to the shell profile once.
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *)
    line="export PATH=\"$prefix/bin:\$PATH\""
    case "${SHELL:-}" in */zsh) rc="$HOME/.zshrc" ;; */bash) rc="$HOME/.bashrc" ;; *) rc="" ;; esac
    if [[ $skip_shell -eq 0 && $interactive -eq 1 && -n "$rc" ]] && ! grep -qsF "$prefix/bin" "$rc"; then
      reply=$(ask "Add $prefix/bin to PATH in $rc? [Y/n] ")
      if [[ ! "$reply" =~ ^[Nn] ]]; then
        printf '\n# Daybook notes CLI\n%s\n' "$line" >> "$rc"
        echo "✓ Added to $rc (open a new terminal, or run: source $rc)"
      else todo+=("Add to your shell profile: $line"); fi
    elif ! grep -qsF "$prefix/bin" "${rc:-/dev/null}"; then
      todo+=("Add to your shell profile: $line")
    fi ;;
esac

# Notes: clone the private notes repository (the one chosen in Daybook's Setup) if it isn't here yet.
notes_dir="${NOTES_DIR:-$HOME/notes}"
if [[ $skip_notes -eq 0 ]]; then
  if git -C "$notes_dir" rev-parse --git-dir >/dev/null 2>&1; then
    echo "✓ Using your notes in $notes_dir"
  elif [[ -e "$notes_dir" && -n "$(ls -A "$notes_dir" 2>/dev/null)" ]]; then
    todo+=("$notes_dir exists but isn't a Git clone. Move it aside, or set NOTES_DIR to your notes clone.")
  else
    if [[ -z "$notes_repo" && $interactive -eq 1 ]]; then
      echo "Your notes live in a private GitHub repository (Daybook → Settings shows it, e.g. you/notes-data)."
      notes_repo=$(ask "Notes repository to clone into $notes_dir (owner/repo, blank to skip): ")
    fi
    if [[ -z "$notes_repo" ]]; then
      todo+=("Clone your notes: git clone git@github.com:OWNER/REPO.git \"$notes_dir\"  (or rerun with --notes-repo OWNER/REPO)")
    elif [[ ! "$notes_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
      # A full Git URL or path (another host, or a local mirror).
      if git clone -q "$notes_repo" "$notes_dir"; then echo "✓ Cloned $notes_repo into $notes_dir"
      else todo+=("Couldn't clone $notes_repo; clone your notes into $notes_dir yourself."); fi
    else
      cloned=0
      # gh uses your GitHub sign-in; then SSH; then HTTPS (which may ask for a token).
      if command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && gh repo clone "$notes_repo" "$notes_dir" -- -q; then cloned=1
      elif git clone -q "git@github.com:$notes_repo.git" "$notes_dir" 2>/dev/null; then cloned=1
      elif git clone -q "https://github.com/$notes_repo.git" "$notes_dir"; then cloned=1; fi
      if [[ $cloned -eq 1 ]]; then echo "✓ Cloned $notes_repo into $notes_dir"
      else todo+=("Couldn't clone $notes_repo. Check you can reach it (gh auth login, or an SSH key), then rerun this script."); fi
    fi
  fi
  # Capturing commits, so the clone needs an author.
  if git -C "$notes_dir" rev-parse --git-dir >/dev/null 2>&1 && [[ -z "$(git -C "$notes_dir" config user.email || true)" ]]; then
    todo+=("Set your Git name and email: git config --global user.name 'Your Name'; git config --global user.email you@example.com")
  fi
  [[ -n "${NOTES_DIR:-}" ]] || [[ "$notes_dir" == "$HOME/notes" ]] || todo+=("Add to your shell profile: export NOTES_DIR=\"$notes_dir\"")
fi

if [[ ${#todo[@]} -eq 0 ]]; then
  echo "All set. Try: note 'Hello from the terminal'"
else
  echo; echo "Still to do:"
  for item in "${todo[@]}"; do echo "  • $item"; done
fi
