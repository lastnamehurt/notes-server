# AI assistants

Your notes server speaks standard remote MCP over HTTPS, so any assistant that can add a custom remote MCP server can connect to it. The phone app at `/app` works without any assistant.

Status means what we have actually checked. "Reported" means a third-party guide says it works; we have not tested it.

| Assistant | Status | Notes |
|---|---|---|
| Claude (claude.ai) | Confirmed | Connected through **Settings → Connectors**. Connectors belong to the Claude account you're signed into. |
| ChatGPT | Reported, not tested | Needs Developer Mode, which some guides place under Settings → Connectors → Advanced. Plan requirements differ between sources. |
| Gemini (gemini.google.com) | Reported, not tested; likely unavailable | One guide describes Settings → Connected Apps → Add a custom app. Other reports say custom MCP is limited to Google AI Ultra on personal accounts, or not offered in the consumer app. |
| Microsoft Copilot | Not evaluated | |
| Perplexity | Not evaluated | |

## Connecting Claude

1. Open [claude.ai](https://claude.ai) in a browser and go to **Settings → Connectors**.
2. Choose **Add custom connector**. Name it **Notes** and paste your app's address with `/mcp` on the end, for example `https://personal-notes-mcp.yourname.workers.dev/mcp`.
3. A sign-in page opens. Enter your password and tap **Allow**.

The Claude connector still asks for the password, even when the phone app uses GitHub sign-in.

## Connecting ChatGPT (not yet tested)

Steps as reported by third-party guides. Menus change often, so check OpenAI's current help for connecting custom MCP servers.

1. Turn on Developer Mode (Settings → Connectors → Advanced, in some versions).
2. Under Connectors, choose **Create**, enter a name and a description, and paste your app's `/mcp` address.
3. Start a new chat and select the connector from the tools menu.

Before relying on this, check it end to end: sign-in completes, your notes are listed by a tool call, and a write such as "log: oatmeal" appears in the app.

## Connecting Gemini (not yet tested)

Only one third-party guide describes a consumer-app flow (Settings → Connected Apps → Add a custom app). Treat it as unavailable until you can see that option in your own account.

## Sources

Third-party guides, not official documentation. Verify against each vendor's current help page before relying on them.

- [Auth0: add a remote MCP server to ChatGPT](https://auth0.com/blog/add-remote-mcp-server-chatgpt/)
- [Zuplo: connect ChatGPT](https://zuplo.com/docs/mcp-gateway/connect-clients/chatgpt)
- [Skills Playground: Gemini custom apps](https://skillsplayground.com/integrations/gemini/)
- [Google Cloud: custom MCP servers for Gemini Enterprise](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server) (enterprise product, not the consumer app)
