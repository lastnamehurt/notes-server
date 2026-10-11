# AI assistants

Your notes server speaks standard remote MCP over HTTPS, so any assistant that can add a custom remote MCP server can connect to it. The phone app at `/app` works without any assistant.

Status means what we have actually checked. "Reported" means a third-party guide says it works; we have not tested it.

| Assistant | Status | Notes |
|---|---|---|
| Claude (claude.ai) | Confirmed | Connected through **Settings → Connectors**. Connectors belong to the Claude account you're signed into. |
| ChatGPT | Documented by OpenAI, not tested | Add a custom MCP server under Plugins. OpenAI recommends OAuth. Plan requirements not stated. |
| Gemini (gemini.google.com) | Reported, not tested; likely unavailable | One guide describes Settings → Connected Apps → Add a custom app. Other reports say custom MCP is limited to Google AI Ultra on personal accounts, or not offered in the consumer app. |
| Microsoft Copilot | Not evaluated | |
| Perplexity | Not evaluated | |

## Connecting Claude

1. Open [claude.ai](https://claude.ai) in a browser and go to **Settings → Connectors**.
2. Choose **Add custom connector**. Name it **Notes** and paste your app's address with `/mcp` on the end, for example `https://personal-notes-mcp.yourname.workers.dev/mcp`.
3. A sign-in page opens. Enter your password and tap **Allow**.

The Claude connector still asks for the password, even when the phone app uses GitHub sign-in.

## Connecting ChatGPT (steps from OpenAI's docs, not yet tested)

Source: [OpenAI's MCP developer docs](https://developers.openai.com/api/docs/mcp). Older guides describe Developer Mode and a Connectors menu; OpenAI's current page doesn't mention those, so don't follow them.

1. Go to **ChatGPT Plugins**, select the **+** button, then **Add custom MCP server**.
2. Enter the server URL and authentication details. Your server uses OAuth, which OpenAI recommends.
3. Review the risk warning, select **I understand and want to continue**, then **Create as a plugin**.
4. Install the plugin and test it by running a prompt in chat.

Before relying on this, check it end to end: sign-in completes, your notes are listed by a tool call, and a write such as "log: oatmeal" appears in the app.

Open questions: OpenAI's example URL ends in `/sse/`, but this server serves MCP at `/mcp`. Check whether ChatGPT connects to `/mcp`. Plan requirements are not stated on the page.

## Connecting Gemini (not yet tested)

Only one third-party guide describes a consumer-app flow (Settings → Connected Apps → Add a custom app). Treat it as unavailable until you can see that option in your own account.

## Sources

The OpenAI link is official developer documentation. The others are third-party guides; verify them against each vendor's current help page before relying on them.

- [OpenAI: MCP developer docs](https://developers.openai.com/api/docs/mcp) (ChatGPT steps)
- [Auth0: add a remote MCP server to ChatGPT](https://auth0.com/blog/add-remote-mcp-server-chatgpt/) (older, third party)
- [Zuplo: connect ChatGPT](https://zuplo.com/docs/mcp-gateway/connect-clients/chatgpt) (older, third party)
- [Skills Playground: Gemini custom apps](https://skillsplayground.com/integrations/gemini/)
- [Google Cloud: custom MCP servers for Gemini Enterprise](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server) (enterprise product, not the consumer app)
