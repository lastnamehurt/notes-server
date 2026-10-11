#!/usr/bin/env bash
# Install both CLI names without replacing an existing command by default.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
prefix="${HOME}/.local"
force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || { echo 'install-cli: --prefix needs a directory' >&2; exit 2; }
      prefix="$2"; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help)
      echo 'Usage: scripts/install-cli.sh [--prefix DIR] [--force]'
      echo 'Links note and notes into DIR/bin (default: ~/.local/bin). Keep this checkout.'
      echo '--force replaces existing command files or symlinks; directories are never replaced.'
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
echo "Installed note and notes in $prefix/bin"
echo "Add that directory to PATH and set NOTES_DIR to your notes clone (default: ~/notes)."
