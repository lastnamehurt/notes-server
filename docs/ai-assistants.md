# AI assistants

Your notes server speaks standard remote MCP over HTTPS, so any assistant that can add a custom remote MCP server can connect to it. The phone app at `/app` works without any assistant.

Status means what we have actually checked. "Reported" means a third-party guide says it works; we have not tested it.

| Assistant | Status | Notes |
|---|---|---|
| Claude (claude.ai) | Confirmed | Connected through **Settings → Connectors**. Connectors belong to the Claude account you're signed into. |
| ChatGPT | Confirmed (ChatGPT Pro, 2026-10-11) | Added as a custom MCP server under Plugins, using OAuth. Requires the `/mcp` address. |
| Gemini (gemini.google.com) | Reported, not tested; likely unavailable | One guide describes Settings → Connected Apps → Add a custom app. Other reports say custom MCP is limited to Google AI Ultra on personal accounts, or not offered in the consumer app. |
| Microsoft Copilot | Not evaluated | |
| Perplexity | Not evaluated | |

## Connecting Claude

1. Open [claude.ai](https://claude.ai) in a browser and go to **Settings → Connectors**.
2. Choose **Add custom connector**. Name it **Notes** and paste your app's address with `/mcp` on the end, for example `https://personal-notes-mcp.yourname.workers.dev/mcp`.
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

## Connecting Gemini (not yet tested)

Only one third-party guide describes a consumer-app flow (Settings → Connected Apps → Add a custom app). Treat it as unavailable until you can see that option in your own account.

## Sources

The OpenAI link is official developer documentation. The others are third-party guides; verify them against each vendor's current help page before relying on them.

- [OpenAI: MCP developer docs](https://developers.openai.com/api/docs/mcp) (ChatGPT steps; checked against the live flow)
- [Skills Playground: Gemini custom apps](https://skillsplayground.com/integrations/gemini/)
- [Google Cloud: custom MCP servers for Gemini Enterprise](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server) (enterprise product, not the consumer app)
