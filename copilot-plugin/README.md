# Renor

GitHub Copilot plugin that connects agents to [Renor](https://renor.cloud), durable memory for AI agents, through Renor's hosted remote [Model Context Protocol](https://modelcontextprotocol.io/) server.

Tell an agent something once. Renor keeps it, and your agents in Copilot (and Claude Code, Cursor, Codex and the rest) recall it when it is relevant later.

This plugin needs a Renor account (<https://renor.cloud>) and connects only to the hosted service. To connect to an engine you run yourself, follow the VS Code steps in the [engine README](https://github.com/renorai/renor-engine#connect-your-agent) instead.

## Install
Until Renor is listed in a Copilot plugin marketplace, install it with the Copilot CLI, run from the `engine/` folder (or the root of the public repository):

```
copilot plugin install ./copilot-plugin
```

Then start Copilot and sign in to Renor in your browser when it asks. Without the plugin, VS Code users can add the same server by hand: Command Palette › **MCP: Add Server** › HTTP › `https://mcp.renor.cloud/mcp`.

## MCP

`mcp.json` declares one server, `renor`, at `https://mcp.renor.cloud/mcp`. Auth is OAuth: there is no key to copy and none is stored in the plugin. New to Renor? Create an account at <https://renor.cloud> first.

## Skill

`renor-memory` tells the agent when to use Renor without being asked:

- **Recall** with `get_context` when starting substantive work, before deciding something an earlier session may have settled, before reviewing another agent's work, and whenever you refer to something not in the conversation.
- **Save** with `remember` the decisions, root causes, corrections and preferences that should survive the session, with their reason. Status and progress logs are not saved, and credentials never are.

## Notes

- Tool calls run as the Renor user who authorizes the connection, in that user's own workspace.
- `https://mcp.renor.cloud/mcp` is the only Renor MCP endpoint.
- Renor's engine is open source (Apache-2.0) and can be self-hosted: <https://github.com/renorai/renor-engine>. This plugin points at the hosted service.

## License

MIT, see [LICENSE](./LICENSE).
