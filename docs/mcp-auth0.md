# Auth0 MCP Server

Gives an AI assistant controlled access to the Auth0 Management API over MCP
(stdio transport). Package: [`@auth0/auth0-mcp-server`](https://www.npmjs.com/package/@auth0/auth0-mcp-server)
(currently **beta**, latest `0.1.0-beta.19`). Requires **Node.js >= 18**.

## Config files in this repo

| File | Used by |
| --- | --- |
| `.mcp.json` | Claude Code and other clients reading a project-scoped `mcpServers` map |
| `.cursor/mcp.json` | Cursor |
| `.vscode/mcp.json` | VS Code (uses `servers` + explicit `"type": "stdio"`) |

All three declare the same server:

```json
{
  "mcpServers": {
    "auth0": {
      "command": "npx",
      "args": ["-y", "@auth0/auth0-mcp-server", "run"]
    }
  }
}
```

## One-time authentication

The server stores credentials in the OS keychain, so you must authenticate
before the client can use any tool:

```bash
npx -y @auth0/auth0-mcp-server init
```

This runs a device-authorization login against your Auth0 tenant. Useful flags:

- `--tenant <name>` – pick a specific tenant when you have several.
- `--scopes <list>` – request additional Management API scopes (read-only by default).

Check session state at any time:

```bash
npx -y @auth0/auth0-mcp-server session
npx -y @auth0/auth0-mcp-server logout
```

## Notes

- `run` speaks MCP over stdio; the client spawns it, you never start it manually.
- Because it can mutate tenant configuration (apps, APIs, actions, logs), point it
  at a **dev/staging tenant** first and keep the granted scopes minimal.
- No secrets are stored in these JSON files — nothing here needs to be gitignored.
