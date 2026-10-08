# Roadmap — and three corrections to the strategy

## Corrections worth keeping on record

**1. The MCP console is not the right vantage point for token cost.**
This process sits between an MCP *client* and an MCP *server*. LLM tokens are
consumed between the client and the *model*; the MCP protocol transports no
usage data whatsoever. Any "tokens saved" number produced here would be
fabricated. What is honestly measurable is **tool payload size** (`bytes_in` /
`bytes_out`) — a driver of model cost, not the cost. Real token accounting
requires becoming a proxy in front of the model: a separate architectural
decision, not a line item in Phase 1.

**2. An official MCP dashboard already exists.**
`@modelcontextprotocol/inspector` (v2.10.1, released 2026-10-08) is actively
maintained. The differentiator is not "nobody built one" — it is that the
Inspector is a **stateless debugger**: close the tab and everything is gone. No
history, no cross-session comparison, no audit trail, no policy. Persistence is
the wedge, which is why it is the first thing built here.

**3. Persistent memory is not a research vacuum.**
`mem0` and `zep` are shipping commercial products. A defensible angle is
*visible, user-editable* memory — not being first.

## Phase 1 — "glass box": shipped

Everything below runs today.

- **SQLite persistence** (`node:sqlite`, no native deps) — `data/cela.db`.
  - `sessions`: server, command, advertised info/capabilities, start/end, end reason.
  - `calls`: sequence, tool, args, result **or** error, duration, payload bytes,
    `replay_of` link.
- **Every attempt is recorded**, including failures — the failures are the point.
- **Truthful lifecycle.** If a server dies mid-session the transport close
  handler marks it `server exited`; sessions orphaned by a console crash are
  reconciled at startup. History never claims a dead session is live.
- **Timeline UI** — per-call duration bars, byte counts, error highlighting,
  aggregate stats.
- **Replay** — re-run any stored call against a live connection; the new row is
  linked to the original so you can compare.
- **Export** — JSON and CSV per session.

## Phase 2 — governance (next)

Ordered by what the current schema already supports:

1. **Approval gates** — mark tools as sensitive; hold the call and require a
   click before dispatch. (Needs a pending-call state + SSE/WebSocket push.)
2. **Per-session limits** — max calls per tool, max total payload, max duration.
   The counters already exist in `sessions`; this is policy evaluation before dispatch.
3. **Audit trail** — the `calls` table is already an append-only log. Hardening
   means hash-chaining rows and recording the acting principal.
4. **Kill switch** — `shutdownAll()` exists; it needs a UI control and a
   session-level `end_reason = 'killed'`.

Honest prerequisite: **there is no identity model yet.** RBAC is meaningless
until the console knows who the caller is. Auth comes before permissions.

## Phase 3 — memory

Deferred deliberately. Revisit once Phase 2 has real users; evaluate `mem0`/`zep`
as dependencies before building a graph store from scratch.
