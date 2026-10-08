import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "./config.js";
import { openSession, closeSession, recordCall } from "./db.js";

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

export async function connect(spec) {
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

export async function disconnect(name) {
  const session = sessions.get(name);
  if (!session) return;
  sessions.delete(name);
  closeSession(session.sessionId, "disconnected");
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

/** Call a tool and persist the attempt — successes and failures alike. */
export async function callTool(name, tool, args, { replayOf = null } = {}) {
  const { client, sessionId } = requireSession(name);
  const started = performance.now();

  try {
    const result = await client.callTool({ name: tool, arguments: args ?? {} });
    const durationMs = performance.now() - started;
    const callId = recordCall({ sessionId, tool, args, result, durationMs, replayOf });
    return { callId, sessionId, result, durationMs: Math.round(durationMs) };
  } catch (err) {
    const durationMs = performance.now() - started;
    recordCall({ sessionId, tool, args, error: err.message, durationMs, replayOf });
    throw err;
  }
}

export async function shutdownAll() {
  await Promise.all([...sessions.keys()].map(disconnect));
}
