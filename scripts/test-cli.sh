#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
for tool in git python3 jq timeout; do
  command -v "$tool" >/dev/null || { echo "CLI tests require $tool" >&2; exit 1; }
done
for suite in note-cli note-sync note-mcp note-install; do
  echo "Running $suite tests"
  bash "$ROOT/test/$suite.test.sh"
done
