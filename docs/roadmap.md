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

## Phase 2 — governance: shipped (except RBAC)

Policy lives in `policy.json` and is **re-read on every call**, so an operator can
tighten rules on a live console without restarting it.

- **Approval gates.** A rule with `"action": "approve"` holds the call — the HTTP
  request stays open — until an operator approves or denies it in the UI, or the
  timeout expires. The verdict is persisted with the deciding principal.
- **Limits.** Per-tool (`limits.maxCallsPerSession`) and per-session
  (`sessionLimits.maxCalls`, `maxPayloadBytes`). Denied calls are recorded but
  excluded from the counters they would otherwise inflate.
- **Audit trail.** Every call row carries `decision` (`allowed` / `approved` /
  `denied`), `policy_reason` and `approval_id`; the `approvals` table records
  state, reason, decider and timestamps. Approvals left pending by a crash are
  marked `expired` at startup.
- **Kill switch.** Denies every waiting approval and terminates every MCP child
  process; affected sessions close with `end_reason = 'killed'`.

### Identity: shipped

`src/auth.js` is a provider interface (`local` implemented, `oidc` specified in
[`auth.md`](auth.md)). Sessions are HMAC-signed cookies; `actor` is persisted on
every session, call and approval. Verified: all `/api/*` routes 401 when
anonymous, forged cookies are rejected, logout invalidates.

**Still not done, and deliberately so: RBAC.** Permissions are meaningless while the
console has no identity model — today every caller is an anonymous operator.
**Authentication must land before roles.** This is the single blocking item for
Phase 2 being credible to an engineering team, and it is the natural home for
the Auth0 dependency that started this repo.

### Next: hash-chaining

Now worth doing, because the log finally names people. `AUDIT_FIELDS` /
`canonicalAuditRow()` already fix the serialisation order — including `actor` —
so the chain covers identity from day one instead of being redesigned around it.

## Phase 3 — memory

Deferred deliberately. Revisit once Phase 2 has real users; evaluate `mem0`/`zep`
as dependencies before building a graph store from scratch.
