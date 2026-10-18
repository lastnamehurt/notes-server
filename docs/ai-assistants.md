# AI assistants

Your notes server speaks standard remote MCP over HTTPS, so any assistant that can add a custom remote MCP server can connect to it. The phone app at `/app` works without any assistant.

Status distinguishes confirmed Daybook connections from documented provider support that still needs end-to-end testing. For guided connection buttons, see the [Daybook connection page](https://lastnamehurt.github.io/notes-server/connect.html).

| Assistant | Status | Notes |
|---|---|---|
| Claude (claude.ai) | Confirmed | Connected through **Settings → Connectors**. Connectors belong to the Claude account you're signed into. |
| ChatGPT | Confirmed (ChatGPT Pro, 2026-10-11) | Added as a custom MCP server under Plugins, using OAuth. Requires the `/mcp` address. |
| Gemini (gemini.google.com) | Documented by Google, not tested; may ask for credentials | Web only to connect. Personal accounts only, 18+, US only, Keep Activity on. See below. |
| Cursor | Documented by Cursor, not tested end-to-end | Use the Daybook install button or add a remote server to `~/.cursor/mcp.json`. See below. |
| Claude Code (terminal) | Documented by Anthropic, not tested end-to-end | `claude mcp add --transport http --scope user daybook https://your-worker.workers.dev/mcp`, then `/mcp` → Authenticate. See below. |
| Codex CLI (terminal) | Documented by OpenAI, not tested end-to-end | `codex mcp add daybook --url https://your-worker.workers.dev/mcp`, then `codex mcp login daybook`. See below. |
| Microsoft Copilot | Not evaluated | |
| Perplexity | Not evaluated | |

## Connecting Claude

1. Open [claude.ai](https://claude.ai) in a browser and go to **Settings → Connectors**.
2. Choose **Add custom connector**. Name it **Daybook** and paste your app's address with `/mcp` on the end, for example `https://personal-notes-mcp.yourname.workers.dev/mcp`.
3. A sign-in page opens. Enter your password and tap **Allow**.

The Claude connector still asks for the password, even when the phone app uses GitHub sign-in.

## Connecting ChatGPT

Confirmed on ChatGPT Pro on 2026-10-11. Menus change, so check OpenAI's [MCP developer docs](https://developers.openai.com/api/docs/mcp) if a step doesn't match.

1. In ChatGPT, go to **Plugins**, select **+**, then **Add custom MCP server**.
2. Enter your server's address with `/mcp` on the end, for example `https://personal-notes-mcp.yourname.workers.dev/mcp`. Don't use `/sse`; this server serves MCP at `/mcp`.
3. For authentication, choose **OAuth**.
4. Accept the risk warning, then choose **Create as a plugin**.
5. A sign-in page opens and shows the access requested: `notes:read, notes:write`. Enter your notes password and tap **Allow**.
6. In a new chat, ask it to list your notes or to log something, to confirm it works.

If **Allow** does nothing, the browser probably blocked the redirect back to ChatGPT. This was fixed on the server in [PR #13](https://github.com/lastnamehurt/notes-server/pull/13). If you still see the problem after that deployment, reload the sign-in page once and try again.

To change what the plugin can access, or to re-authorize, remove the plugin in ChatGPT and add it again. Old plugins may still appear in the list after uninstalling. Each one that points to a dead address can be ignored, but it still holds its own sign-in.

## Connecting Gemini (documented, not tested)

Source: [Gemini Apps Help: connect custom apps](https://support.google.com/gemini/answer/17209137?hl=en).

Who can use it, per Google:

- You must sign in with a **personal** Google account. Work or school accounts aren't supported.
- You must be **18 or over and in the US**.
- **Keep Activity** must be on. Custom apps are unavailable when it's off.
- The feature is **English only** for now.

Steps (web only):

1. Go to gemini.google.com, then **Settings → Connected Apps**. If you don't see it, choose **Personal Intelligence**, then **Connected Apps**.
2. Under **Custom apps**, add a custom app and enter the MCP server URL: `https://your-worker.workers.dev/mcp`.
3. If Gemini requests a client ID and secret under **Advanced features**, do not enter your Daybook password as a client secret. This Daybook deployment uses OAuth; compatibility with Gemini’s client registration flow still needs end-to-end verification.
4. Select **Next** and follow the prompts.

To use the app in a chat, type `@` and pick it. The app works on the Gemini mobile app once connected. Gemini asks for confirmation before any write action.

## Connecting Cursor (documented, not tested)

Sources: [Cursor docs: MCP](https://cursor.com/docs/mcp), and a [Cursor forum report](https://forum.cursor.com/t/remote-mcp-server-connect-button-produces-zero-network-requests-oauth-flow-never-starts/150962).

1. Create or edit `~/.cursor/mcp.json`, or `.cursor/mcp.json` for a single project. Add a remote entry with a `url`:

   ```json
   {
     "mcpServers": {
       "notes": {
         "url": "https://your-worker.workers.dev/mcp"
       }
     }
   }
   ```

2. Cursor supports OAuth for servers that need it. Use the [Daybook Connect page](https://lastnamehurt.github.io/notes-server/connect.html) for its install button, or the configuration above. If authorization fails, check the OAuth exchange; do not place your Daybook password or bearer token in the config.
3. Cursor manages its OAuth redirect during authorization. We have not verified the full Daybook → Cursor sign-in flow.

Known issue: a Cursor forum report says **Connect** does nothing for URL servers that need OAuth, with no browser window and no network request. If that happens, the config file is probably being read but the OAuth step never starts.

If the install link does not work, use the config-file fallback above.

## Connecting Claude Code and Codex (terminal)

Coding tools in a terminal have no connector screen: one command adds Daybook, a second step signs in. Daybook's app shows both commands, filled in with your address, under **Connect an assistant → Coding tools in a terminal**. Run them once on each computer.

Both tools identify themselves to Daybook with an OAuth client metadata document, so Daybook needs no extra registration setting. The sign-in page asks for your Daybook password and says the request **redirects to your local computer**: that's the tool's sign-in listener on `localhost`, and it's expected.

### Claude Code

```sh
claude mcp add --transport http --scope user daybook https://your-worker.workers.dev/mcp
```

`--scope user` makes Daybook available in every project (the default, `local`, is only the current folder). Then start `claude`, type `/mcp`, pick **daybook** and choose **Authenticate**; or run `claude mcp login daybook` from the shell. To have Claude Code use Daybook unprompted, add the instruction from **Make your assistant use Daybook** to `~/.claude/CLAUDE.md`.

### Codex CLI

```sh
codex mcp add daybook --url https://your-worker.workers.dev/mcp
codex mcp login daybook
```

The same server also appears in the Codex IDE extension, which shares `~/.codex/config.toml`. For standing instructions, add the snippet to `~/.codex/AGENTS.md`.

Verify either one by asking: *"List my latest Daybook notes."*

## Sources

Google and OpenAI links below are official documentation; Cursor documentation is official, while the forum report is a third-party issue report. Documented support does not mean we have completed Daybook-specific OAuth testing.

- [OpenAI: MCP developer docs](https://developers.openai.com/api/docs/mcp) (ChatGPT steps; checked against the live flow)
- [Gemini Apps Help: connect custom apps](https://support.google.com/gemini/answer/17209137?hl=en) (consumer app)
- [Cursor docs: MCP](https://cursor.com/docs/mcp)
- [Claude Code docs: MCP](https://code.claude.com/docs/en/mcp)
- [Codex docs: MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Cursor forum: Connect button does nothing](https://forum.cursor.com/t/remote-mcp-server-connect-button-produces-zero-network-requests-oauth-flow-never-starts/150962)
- [Codex MCP documentation](https://developers.openai.com/codex/mcp/) (CLI setup)
- [Google Cloud: custom MCP servers for Gemini Enterprise](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server) (enterprise product, not the consumer app)
