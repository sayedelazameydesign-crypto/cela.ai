/**
 * Persistence layer: sessions and tool calls.
 *
 * Uses node:sqlite (built into Node >= 22.5) so the console has zero native
 * dependencies. The file lives in data/cela.db and is gitignored.
 *
 * Honest note on accounting: this process sits between an MCP *client* and an
 * MCP *server*. The protocol carries no LLM token usage, so we record payload
 * bytes — a driver of model cost, never the cost itself. Columns are named
 * accordingly (bytes_in / bytes_out), not "tokens".
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const dir = path.join(ROOT, "data");
mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(path.join(dir, "cela.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name   TEXT    NOT NULL,
    command       TEXT    NOT NULL,
    server_info   TEXT,
    capabilities  TEXT,
    started_at    TEXT    NOT NULL,
    ended_at      TEXT,
    end_reason    TEXT
  );

  CREATE TABLE IF NOT EXISTS calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES sessions(id),
    seq          INTEGER NOT NULL,
    tool         TEXT    NOT NULL,
    args         TEXT    NOT NULL,
    result       TEXT,
    error        TEXT,
    is_error     INTEGER NOT NULL DEFAULT 0,
    bytes_in     INTEGER NOT NULL DEFAULT 0,
    bytes_out    INTEGER NOT NULL DEFAULT 0,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    replay_of    INTEGER REFERENCES calls(id),
    created_at   TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id),
    server      TEXT    NOT NULL,
    tool        TEXT    NOT NULL,
    args        TEXT    NOT NULL,
    reason      TEXT,
    state       TEXT    NOT NULL DEFAULT 'pending',
    decision_reason TEXT,
    decided_by  TEXT,
    created_at  TEXT    NOT NULL,
    decided_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_sessions_server ON sessions(server_name, started_at DESC);
`);

/** Additive migrations for databases created by an earlier version. */
function addColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn("calls", "decision", "TEXT NOT NULL DEFAULT 'allowed'");
addColumn("calls", "policy_reason", "TEXT");
addColumn("calls", "approval_id", "INTEGER");
addColumn("calls", "actor", "TEXT NOT NULL DEFAULT 'anonymous'");
addColumn("sessions", "actor", "TEXT NOT NULL DEFAULT 'anonymous'");
addColumn("approvals", "requested_by", "TEXT");

const now = () => new Date().toISOString();
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null), "utf8");

export function openSession({ serverName, command, serverInfo, capabilities, actor }) {
  const stmt = db.prepare(
    `INSERT INTO sessions (server_name, command, server_info, capabilities, started_at, actor)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    serverName,
    command,
    JSON.stringify(serverInfo ?? null),
    JSON.stringify(capabilities ?? null),
    now(),
    actor ?? "anonymous"
  );
  return Number(info.lastInsertRowid);
}

export function closeSession(sessionId, reason = "disconnected") {
  db.prepare(`UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`).run(
    now(),
    reason,
    sessionId
  );
}

export function recordCall({ sessionId, tool, args, result, error, durationMs, replayOf, decision, policyReason, approvalId, actor }) {
  const seqRow = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM calls WHERE session_id = ?`).get(sessionId);
  const isError = error ? 1 : result?.isError ? 1 : 0;

  const stmt = db.prepare(
    `INSERT INTO calls (session_id, seq, tool, args, result, error, is_error,
                        bytes_in, bytes_out, duration_ms, replay_of, created_at,
                        decision, policy_reason, approval_id, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    sessionId,
    seqRow.next,
    tool,
    JSON.stringify(args ?? {}),
    result ? JSON.stringify(result) : null,
    error ?? null,
    isError,
    bytes(args ?? {}),
    result ? bytes(result) : 0,
    Math.round(durationMs),
    replayOf ?? null,
    now(),
    decision ?? "allowed",
    policyReason ?? null,
    approvalId ?? null,
    actor ?? "anonymous"
  );
  return Number(info.lastInsertRowid);
}

const SESSION_SELECT = `
  SELECT s.*,
         COUNT(c.id)                        AS call_count,
         COALESCE(SUM(c.is_error), 0)       AS error_count,
         COALESCE(SUM(c.bytes_in), 0)       AS bytes_in,
         COALESCE(SUM(c.bytes_out), 0)      AS bytes_out,
         COALESCE(SUM(c.duration_ms), 0)    AS total_ms
  FROM sessions s
  LEFT JOIN calls c ON c.session_id = s.id
`;

export function listSessions(limit = 50) {
  return db.prepare(`${SESSION_SELECT} GROUP BY s.id ORDER BY s.started_at DESC LIMIT ?`).all(limit);
}

export function getSession(id) {
  return db.prepare(`${SESSION_SELECT} WHERE s.id = ? GROUP BY s.id`).get(id);
}

export function listCalls(sessionId) {
  return db
    .prepare(`SELECT * FROM calls WHERE session_id = ? ORDER BY seq ASC`)
    .all(sessionId)
    .map((row) => ({
      ...row,
      args: JSON.parse(row.args),
      result: row.result ? JSON.parse(row.result) : null,
      is_error: Boolean(row.is_error),
    }));
}

export function getCall(id) {
  const row = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, args: JSON.parse(row.args), result: row.result ? JSON.parse(row.result) : null };
}

/** Mark sessions left open by a previous crash so history stays truthful. */
export function reconcileOrphans() {
  const info = db
    .prepare(`UPDATE sessions SET ended_at = started_at, end_reason = 'orphaned' WHERE ended_at IS NULL`)
    .run();
  return Number(info.changes);
}

/* ---------- governance ---------- */

export function recordApproval({ sessionId, server, tool, args, reason, requestedBy }) {
  const info = db
    .prepare(
      `INSERT INTO approvals (session_id, server, tool, args, reason, state, created_at, requested_by)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(sessionId, server, tool, JSON.stringify(args ?? {}), reason ?? null, now(), requestedBy ?? "anonymous");
  return Number(info.lastInsertRowid);
}

export function decideApproval(id, state, decisionReason, decidedBy) {
  db.prepare(
    `UPDATE approvals SET state = ?, decision_reason = ?, decided_by = ?, decided_at = ?
     WHERE id = ? AND state = 'pending'`
  ).run(state, decisionReason ?? null, decidedBy ?? null, now(), id);
}

export function listApprovals(limit = 50) {
  return db
    .prepare(`SELECT * FROM approvals ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map((row) => ({ ...row, args: JSON.parse(row.args) }));
}

/** Live counters a policy decision needs. */
export function sessionStats(sessionId) {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(bytes_in + bytes_out), 0) AS payloadBytes
       FROM calls WHERE session_id = ? AND decision != 'denied'`
    )
    .get(sessionId);
  const byTool = db
    .prepare(
      `SELECT tool, COUNT(*) AS n FROM calls
       WHERE session_id = ? AND decision != 'denied' GROUP BY tool`
    )
    .all(sessionId);
  return {
    calls: totals.calls,
    payloadBytes: totals.payloadBytes,
    callsByTool: Object.fromEntries(byTool.map((r) => [r.tool, r.n])),
  };
}

/** Mark any approval rows still pending at shutdown so none dangle forever. */
export function reconcilePendingApprovals() {
  const info = db
    .prepare(`UPDATE approvals SET state = 'expired', decided_at = ?, decided_by = 'restart' WHERE state = 'pending'`)
    .run(now());
  return Number(info.changes);
}

/**
 * Canonical serialisation of an audit row.
 *
 * Hash-chaining is intentionally NOT enabled yet, but the chain must survive the
 * columns that identity work keeps adding. Fixing the field ORDER now — rather
 * than hashing "whatever columns exist today" — means a later chain can cover
 * `actor` without a redesign: unknown fields serialise as null, so the ordering
 * is stable across schema versions.
 */
export const AUDIT_FIELDS = [
  "id", "session_id", "seq", "tool", "args", "decision", "policy_reason",
  "approval_id", "actor", "is_error", "bytes_in", "bytes_out", "duration_ms",
  "replay_of", "created_at",
];

export function canonicalAuditRow(row) {
  return JSON.stringify(AUDIT_FIELDS.map((field) => row[field] ?? null));
}
