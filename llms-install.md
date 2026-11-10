# Install Renor in Cline

Connect Cline to Renor over MCP.

Choose the hosted server for managed hybrid search.
Choose the self-hosted engine to keep memory in a folder on this machine.

## Prerequisites

Install Cline in a client that supports MCP settings.
Create a Renor account at [renor.cloud](https://renor.cloud) for the hosted server.
Install Node.js 22.16 or later for the self-hosted engine.
Do not use native Windows for the self-hosted HTTP server.
Use the stdio setup below on native Windows.

## Connect the hosted server

1. Sign in to the Renor dashboard.
2. Open **API keys**.
3. Select **Create connection key**.
4. Name the connection for Cline.
5. Copy the key directly into Cline's MCP settings.
6. Never ask the user to paste the key into chat.
7. Never print the key.
8. Keep the key only in the client configuration.
9. Add this entry to Cline's `mcpServers` settings.
10. Replace `YOUR_RENOR_TOKEN` in the settings editor, not in chat.

```json
{
  "mcpServers": {
    "renor": {
      "type": "streamableHttp",
      "url": "https://mcp.renor.cloud/mcp",
      "headers": { "Authorization": "Bearer YOUR_RENOR_TOKEN" }
    }
  }
}
```

11. Save the MCP settings.
12. Reload Cline.
13. List the Renor MCP tools.
14. Call `memory_status` once as a harmless read-only connection check.
15. Confirm that the reply names the expected hosted workspace and server URL.

## Install the self-hosted engine from npm

1. Check the Node.js version.

```bash
node -v
```

2. Require v22.16 or newer.
3. Add this entry to Cline's `mcpServers` settings.

```json
{
  "mcpServers": {
    "renor-local": {
      "command": "npx",
      "args": ["-y", "renor-engine", "mcp"]
    }
  }
}
```

4. Set `VAULT_PATH` in the server environment to an absolute folder when you do not want the default `~/.renor` folder.
5. Save the MCP settings.
6. Restart Cline.
7. List the Renor MCP tools.
8. Call the read-only `search` tool with a real term from the chosen memory folder.
9. Check the local engine directly when needed.

```bash
npx renor-engine status
```

10. Run the read-only health report when the check fails.

```bash
npx renor-engine doctor
```

## Fix common errors

### Renor needs Node 22.16.0 or newer

Install Node 22 LTS or newer from [nodejs.org](https://nodejs.org).
Run the command again.

### Cline shows no Renor tools or cannot start the server

Save the MCP settings and restart Cline.
Keep `VAULT_PATH` absolute when it is set.
Remove any separately running `renor-engine mcp` process because Cline starts the server itself.
Run the health report and follow its one-line fix.

### The hosted server returns an authentication error

Use only `https://mcp.renor.cloud/mcp` with a dashboard connection key.
Create a new connection key if the old key was revoked.
Put the replacement only in the `Authorization` header in Cline's MCP settings.
Do not send the key to support or paste it into chat.

### The vector search extension does not load

Reinstall `renor-engine` without `--omit=optional`.
Remove `optional=false` from the npm configuration for this install.
