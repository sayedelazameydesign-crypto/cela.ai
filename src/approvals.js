/**
 * Human-in-the-loop approval gates.
 *
 * A gated call is held here — the HTTP request stays open — until an operator
 * approves or denies it, the timeout expires, or the kill switch fires. The
 * decision is persisted so the audit trail shows who stopped what.
 */
import { recordApproval, decideApproval } from "./db.js";

/** id -> { resolve, timer, record } */
const pending = new Map();

export function listPending() {
  return [...pending.values()].map((p) => p.record);
}

export function pendingCount() {
  return pending.size;
}

/**
 * Register a gated call and wait for a decision.
 * @returns {Promise<{approved:boolean, reason:string, by:string}>}
 */
export function requestApproval({ sessionId, server, tool, args, reason, requestedBy }, timeoutMs) {
  const id = recordApproval({ sessionId, server, tool, args, reason, requestedBy });
  const record = {
    id,
    sessionId,
    server,
    tool,
    args,
    reason,
    requestedBy,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
  };

  return new Promise((resolve) => {
    const settle = (outcome) => {
      const entry = pending.get(id);
      if (!entry) return; // already settled
      clearTimeout(entry.timer);
      pending.delete(id);
      decideApproval(id, outcome.approved ? "approved" : "denied", outcome.reason, outcome.by);
      resolve({ ...outcome, id });
    };

    const timer = setTimeout(
      () => settle({ approved: false, reason: `No decision within ${Math.round(timeoutMs / 1000)}s.`, by: "timeout" }),
      timeoutMs
    );
    // Do not keep the event loop alive purely for a pending approval.
    timer.unref?.();

    pending.set(id, { record, timer, settle, resolve });
  });
}

export function decide(id, approved, by = "anonymous") {
  const entry = pending.get(Number(id));
  if (!entry) throw new Error(`No pending approval ${id}.`);
  entry.settle({ approved, reason: `${approved ? "Approved" : "Denied"} by ${by}.`, by });
  return entry.record;
}

/** Deny everything in flight — used by the kill switch. */
export function denyAll(reason = "Kill switch engaged.") {
  const ids = [...pending.keys()];
  for (const id of ids) pending.get(id)?.settle({ approved: false, reason, by: "kill-switch" });
  return ids.length;
}
