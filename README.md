# cela.ai

## MCP servers

This repo ships a project-scoped MCP configuration for the Auth0 MCP server:

- `.mcp.json` — Claude Code and compatible clients
- `.cursor/mcp.json` — Cursor
- `.vscode/mcp.json` — VS Code

Authenticate once before use:

```bash
npx -y @auth0/auth0-mcp-server init
```

See [`docs/mcp-auth0.md`](docs/mcp-auth0.md) for details.
