# Local notes CLI

This repository ships `note` and its alias `notes`. They capture, browse, edit, delete, and sync Markdown notes in a local Git clone of the same private repository used by the app and remote MCP server. The CLI runs locally; the Cloudflare Worker does not invoke it.

## Install

Requires Bash, Git, and Python 3. There are no Python packages to install. Optional `fzf` enables the interactive picker; optional `bat` improves previews.

From this repository's checkout:

```sh
bash scripts/install-cli.sh
export PATH="$HOME/.local/bin:$PATH"
```

Keep the checkout: installation links the commands to its `bin/` directory. Add the PATH setting to your shell configuration. To use a different location, pass `--prefix /path/to/prefix` (commands go in its `bin/`). Existing commands are preserved unless you explicitly pass `--force`.

Clone your app's private notes repository separately, using your own GitHub user and the repository selected in Setup:

```sh
git clone git@github.com:YOUR-USER/notes.git "$HOME/notes"
```

The default data location is `~/notes`. For another clone, set `NOTES_DIR` in your shell:

```sh
export NOTES_DIR="$HOME/my-notes"
```

The data clone must have a checked-out branch, a configured Git author, and an `origin` remote for pushes and sync. Do not point `NOTES_DIR` at this application's source checkout.

## Commands

```sh
note 'Remember to book the appointment'
printf 'A longer note\n' | note
note -t 'Project plan' -f plan.md
note --no-push 'Save locally for now'
note ls
note ls goals
note find appointment
note show inbox/example.md
EDITOR='code -w' note edit example
note rm example
note sync
notes --help
```

Capture, changed edits, and confirmed deletions commit and push by default. `--no-push` leaves the commit local. Run `note sync` after a failed push or a change made in the app/on another machine. Sync rebases local commits and pushes pending work; it does not force-push and reports conflicts for you to resolve.

`note` on a terminal, or `note pick`, opens the `fzf` picker. `note rm` asks for confirmation; `note rm -y` explicitly skips the prompt. Interactive commands refuse with exit code 3 when they need a terminal. Read-only `ls`, `find`, and `show` work unattended.

The supported folders match the app: inbox, goals, projects, decisions, runbooks, reference, and journal. The CLI reads ordinary Markdown headings as well as frontmatter. Capture creates the inbox folder when needed.

## Optional notes-repository hook

The bundled hook blocks likely secrets and sensitive identifiers in added lines. To opt in, run this from the application checkout (this replaces the data clone's `core.hooksPath` setting):

```sh
git -C "${NOTES_DIR:-$HOME/notes}" config core.hooksPath "$PWD/cli/hooks"
```

Existing hooks remain in effect unless you change that setting. Do not capture credentials or personal identifiers: CLI writes are committed and pushed.

## Local MCP backend

`mcp/note-mcp` also serves seven tools over stdio: save, search, list, get, update, delete, and sync. Configure your MCP client to launch `python3` with the absolute path to `mcp/note-mcp` as its argument and `NOTES_DIR` pointing at your data clone. This is an optional local alternative to the hosted MCP connection, and also supplies the CLI's browsing implementation.

## Tests

```sh
npm run test:cli
```

Tests additionally require `jq` and `timeout` (GNU coreutils). They use temporary repositories and local bare remotes, covering capture, browsing, edits, deletions, rejected commits, synchronization and conflicts, MCP operations, and installation. They do not access your personal notes or GitHub. CI runs these checks separately from the Worker checks, and deployment waits for both.
