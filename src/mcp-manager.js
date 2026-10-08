import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "./config.js";
import { openSession, closeSession, recordCall, sessionStats } from "./db.js";
import { loadPolicy, evaluate } from "./policy.js";
import { requestApproval, denyAll } from "./approvals.js";

const CONNECT_TIMEOUT_MS = 90_000;
const MAX_LOG_LINES = 200;

/** name -> { client, transport, info, log, connectedAt } */
const sessions = new Map();

export function sessionState(name) {
  const session = sessions.get(name);
  if (!session) return { connected: false };
  return {
    connected: true,
    sessionId: session.sessionId,
    connectedAt: session.connectedAt,
    serverInfo: session.info.serverInfo,
    capabilities: session.info.capabilities,
    log: session.log,
  };
}

export function stderrLog(name) {
  return sessions.get(name)?.log ?? [];
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function connect(spec, actor = "anonymous") {
  if (sessions.has(spec.name)) return sessionState(spec.name);

  const log = [];
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    cwd: ROOT,
    env: { ...process.env, ...spec.env },
    stderr: "pipe",
  });

  const client = new Client({ name: "cela-ai-console", version: "0.1.0" });

  transport.onerror = (err) => log.push(`[transport] ${err.message}`);

  try {
    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      `Timed out after ${CONNECT_TIMEOUT_MS / 1000}s waiting for "${spec.name}" to start. ` +
        `If it runs through npx, the package may still be downloading, or it may be waiting on credentials.`
    );
  } catch (err) {
    // Surface whatever the child process printed — that is usually the real cause.
    const stderr = transport.stderr;
    if (stderr) {
      const chunks = stderr.read();
      if (chunks) log.push(...String(chunks).split("\n").filter(Boolean));
    }
    await transport.close().catch(() => {});
    const detail = log.length ? `\n\nServer output:\n${log.slice(-20).join("\n")}` : "";
    throw new Error(err.message + detail);
  }

  transport.stderr?.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) log.push(line);
    }
    if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
  });

  const info = {
    serverInfo: client.getServerVersion(),
    capabilities: client.getServerCapabilities(),
  };

  const sessionId = openSession({
    actor,
    serverName: spec.name,
    command: [spec.command, ...spec.args].join(" "),
    serverInfo: info.serverInfo,
    capabilities: info.capabilities,
  });

  // A server that dies mid-session must not leave the history claiming it is live.
  transport.onclose = () => {
    if (sessions.get(spec.name)?.sessionId === sessionId) {
      sessions.delete(spec.name);
      closeSession(sessionId, "server exited");
    }
  };

  sessions.set(spec.name, {
    client,
    transport,
    log,
    sessionId,
    connectedAt: new Date().toISOString(),
    info,
  });

  return sessionState(spec.name);
}

export async function disconnect(name, reason = "disconnected") {
  const session = sessions.get(name);
  if (!session) return;
  sessions.delete(name);
  closeSession(session.sessionId, reason);
  await session.client.close().catch(() => {});
}

function requireSession(name) {
  const session = sessions.get(name);
  if (!session) throw new Error(`Not connected to "${name}". Connect first.`);
  return session;
}

/** Fetch tools/resources/prompts, skipping whatever the server does not advertise. */
export async function inventory(name) {
  const { client, info } = requireSession(name);
  const caps = info.capabilities ?? {};
  const result = { tools: [], resources: [], prompts: [] };

  if (caps.tools) result.tools = (await client.listTools()).tools ?? [];
  if (caps.resources) {
    result.resources = (await client.listResources().catch(() => ({ resources: [] }))).resources ?? [];
  }
  if (caps.prompts) {
    result.prompts = (await client.listPrompts().catch(() => ({ prompts: [] }))).prompts ?? [];
  }
  return result;
}

/**
 * Call a tool, subject to policy, and persist the attempt — successes, denials
 * and failures alike. A gated call blocks here until an operator decides.
 */
export async function callTool(name, tool, args, { replayOf = null, actor = "anonymous" } = {}) {
  const { client, sessionId } = requireSession(name);

  const policy = await loadPolicy();
  const verdict = evaluate(policy, { server: name, tool }, sessionStats(sessionId));
  let approvalId = null;

  if (verdict.action === "deny") {
    recordCall({
      sessionId, tool, args, error: `Blocked by policy: ${verdict.reason}`,
      durationMs: 0, replayOf, decision: "denied", policyReason: verdict.reason, actor,
    });
    throw new Error(`Blocked by policy: ${verdict.reason}`);
  }

  if (verdict.action === "approve") {
    const outcome = await requestApproval(
      { sessionId, server: name, tool, args, reason: verdict.reason, requestedBy: actor },
      policy.approvalTimeoutMs ?? 120_000
    );
    approvalId = outcome.id;

    if (!outcome.approved) {
      recordCall({
        sessionId, tool, args, error: `Approval denied: ${outcome.reason}`,
        durationMs: 0, replayOf, decision: "denied",
        policyReason: outcome.reason, approvalId, actor,
      });
      throw new Error(`Approval denied: ${outcome.reason}`);
    }

    // The session may have been killed while the approval sat waiting.
    if (!sessions.has(name)) throw new Error(`Session for "${name}" ended before approval was granted.`);
  }

  const decision = approvalId ? "approved" : "allowed";
  const started = performance.now();

  try {
    const result = await client.callTool({ name: tool, arguments: args ?? {} });
    const durationMs = performance.now() - started;
    const callId = recordCall({
      sessionId, tool, args, result, durationMs, replayOf,
      decision, policyReason: verdict.reason, approvalId, actor,
    });
    return { callId, sessionId, result, durationMs: Math.round(durationMs), decision };
  } catch (err) {
    const durationMs = performance.now() - started;
    recordCall({
      sessionId, tool, args, error: err.message, durationMs, replayOf,
      decision, policyReason: verdict.reason, approvalId, actor,
    });
    throw err;
  }
}

export async function shutdownAll(reason = "disconnected") {
  denyAll("Console shutting down.");
  await Promise.all([...sessions.keys()].map((name) => disconnect(name, reason)));
}

/** Emergency stop: refuse every waiting approval and tear down every child process. */
export async function killSwitch() {
  const deniedApprovals = denyAll("Kill switch engaged.");
  const names = [...sessions.keys()];
  await Promise.all(names.map((name) => disconnect(name, "killed")));
  return { deniedApprovals, killedSessions: names };
}
