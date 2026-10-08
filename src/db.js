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

  CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_sessions_server ON sessions(server_name, started_at DESC);
`);

const now = () => new Date().toISOString();
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null), "utf8");

export function openSession({ serverName, command, serverInfo, capabilities }) {
  const stmt = db.prepare(
    `INSERT INTO sessions (server_name, command, server_info, capabilities, started_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    serverName,
    command,
    JSON.stringify(serverInfo ?? null),
    JSON.stringify(capabilities ?? null),
    now()
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

export function recordCall({ sessionId, tool, args, result, error, durationMs, replayOf }) {
  const seqRow = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM calls WHERE session_id = ?`).get(sessionId);
  const isError = error ? 1 : result?.isError ? 1 : 0;

  const stmt = db.prepare(
    `INSERT INTO calls (session_id, seq, tool, args, result, error, is_error,
                        bytes_in, bytes_out, duration_ms, replay_of, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    now()
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
