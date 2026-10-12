#!/usr/bin/env bash
set -euo pipefail
: "${NOTES_BASE_URL:?Set NOTES_BASE_URL to the isolated E2E Worker URL}"
: "${NOTES_E2E_PASSWORD:?Set NOTES_E2E_PASSWORD for the E2E instance}"
case "$NOTES_BASE_URL" in
  *daybook-e2e.*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "Refusing tests: NOTES_BASE_URL must target daybook-e2e or localhost" >&2; exit 1 ;;
esac
npx playwright test --config=playwright.config.mjs "$@"
