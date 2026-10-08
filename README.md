# cela.ai — MCP Console

A small web console that reads the MCP server definitions already sitting in this
repo, launches them over stdio, performs the MCP handshake, and lets you call
their tools from the browser with forms generated from each tool's JSON Schema.

```bash
npm install
npm start          # http://127.0.0.1:3000 — prints an operator token at startup
```

Sign in with the token from the server log. Pin it with `AUTH_TOKEN=…`, and bind
beyond loopback only on purpose (`HOST=0.0.0.0`). See [`docs/auth.md`](docs/auth.md).

**Status:** Phase 1 ("glass box") and Phase 2 ("governor") are shipped, plus
operator identity. RBAC is intentionally not built yet — see [`docs/roadmap.md`](docs/roadmap.md).

## What it does

- **Reads every config format in the repo** — `.mcp.json`, `.cursor/mcp.json`
  (`mcpServers`), `.vscode/mcp.json` (`servers`) and `mcp.local.json` — merging
  them by server name and showing which files declared each one.
- **Connects on demand.** Spawns the server as a child process, speaks MCP over
  stdio, and reports the advertised name, version and capabilities.
- **Lists tools, resources and prompts**, skipping whatever a server does not
  advertise.
- **Builds a form per tool** from its `inputSchema`: text, number, boolean,
  enum (`select`) and JSON textareas for objects/arrays. Required fields are
  validated client-side; empty optional fields are omitted rather than sent as `""`.
- **Persists every session and call** to SQLite (`data/cela.db`, via built-in
  `node:sqlite` — no native dependencies): duration, payload bytes, args, result
  or error. Failed calls are recorded too.
- **Timeline, replay and export.** Browse past sessions, re-run any stored call
  against a live connection (linked to the original for comparison), and export
  a session as JSON or CSV.
- **Requires an identity for every action.** HMAC-signed session cookies, a
  pluggable auth provider (`local` today, OIDC by contract), and `actor` recorded
  on every session, call and approval decision.
- **Governs calls before they run.** `policy.json` (hot-reloaded on every call)
  can allow, gate or deny a tool. Gated calls block until an operator clicks
  Approve or Deny in the UI; per-tool and per-session limits deny automatically;
  a kill switch denies all pending approvals and terminates every child process.
- **Shows real failures.** If a server dies during startup its stderr is captured
  and returned instead of a bare "connection closed", which is what you actually
  need to debug an MCP launch.

## Layout

| Path | Role |
| --- | --- |
| `src/server.js` | Express API + static hosting |
| `src/config.js` | Discovers and normalises server definitions |
| `policy.json` | Governance rules (hot-reloaded) |
| `src/auth.js` | Identity: providers, sessions, `requireAuth` |
| `src/policy.js` | Policy evaluation: allow / approve / deny |
| `src/approvals.js` | Holds gated calls until a human decides |
| `src/db.js` | SQLite schema, session/call recording, queries |
| `src/mcp-manager.js` | Connection lifecycle, inventory, tool calls, stderr capture |
| `mcp-servers/demo.js` | Bundled demo MCP server (`echo`, `list_files`, `read_file`, `repo_summary`) |
| `public/` | Vanilla JS front end, no build step |

### API

| Method | Route |
| --- | --- |
| `GET` | `/api/servers` |
| `POST` | `/api/servers/:name/connect` |
| `POST` | `/api/servers/:name/disconnect` |
| `GET` | `/api/servers/:name/inventory` |
| `POST` | `/api/servers/:name/call` — body `{ "tool": "...", "args": { } }` |
| `GET` | `/api/sessions` |
| `GET` | `/api/sessions/:id` — session + full call timeline |
| `GET` | `/api/sessions/:id/export?format=json\|csv` |
| `POST` | `/api/calls/:id/replay` |
| `GET` | `/api/approvals` — pending + recent decisions |
| `POST` | `/api/approvals/:id/decide` — body `{ "approve": true }` |
| `GET` | `/api/policy` |
| `GET` | `/api/auth/me` · `POST` `/api/auth/login` · `POST` `/api/auth/logout` |
| `POST` | `/api/kill` — emergency stop |

## The two servers you'll see

**`cela-demo`** (from `mcp.local.json`) works immediately — it's a read-only
server scoped to this repository, with a guard that rejects paths escaping the
repo root. Use it to verify the console end to end.

**`auth0`** (from `.mcp.json`) is the real [`@auth0/auth0-mcp-server`](https://www.npmjs.com/package/@auth0/auth0-mcp-server).
It needs a one-time login before any tool call will work:

```bash
npx -y @auth0/auth0-mcp-server init
```

It stores credentials via `keytar`, so it requires a machine with an OS keychain
(macOS Keychain, Windows Credential Manager, or libsecret on Linux). In a
headless container it exits at startup with
`Failed to load keytar native addon` — the console surfaces that message
verbatim. See [`docs/mcp-auth0.md`](docs/mcp-auth0.md).

## Scope / caveats

- **No roles yet.** Authentication exists; authorisation does not. Every
  authenticated operator can do everything, so only grant the token to people you
  would trust with a shell on the host.
- **Audit rows are not tamper-evident yet.** Anyone with write access to
  `data/cela.db` can rewrite history; hash-chaining is the next task.
- **Byte counts are not token counts.** This console sits between an MCP client
  and an MCP server; the protocol carries no LLM usage data. Payload size drives
  model cost but is not model cost. Anything claiming otherwise would be invented.
- stdio servers only; remote (`url` / `type: "http"`) entries are listed as a
  config note rather than connected to.
- Connections live in the console process memory and are closed on shutdown.
- No auth on the console itself — it spawns local processes, so keep it bound to
  a machine you trust rather than exposing it publicly.
