import express from "express";
import path from "node:path";
import { loadServers, ROOT } from "./config.js";
import * as mcp from "./mcp-manager.js";
import * as store from "./db.js";
import * as approvals from "./approvals.js";
import { loadPolicy } from "./policy.js";
import * as auth from "./auth.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

/* ---------- identity ---------- */

app.get("/api/auth/me", (req, res) => {
  const user = auth.currentUser(req);
  res.json({ user, provider: auth.providerName });
});

app.post("/api/auth/login", (req, res) => {
  try {
    const identity = auth.login(req.body ?? {});
    auth.setSessionCookie(res, auth.issueSession(identity));
    res.json({ user: identity });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// Everything below this line requires an identity. Nothing acts anonymously.
app.use("/api", auth.requireAuth);

/** Wrap an async route so rejections become JSON errors instead of hanging. */
const route = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

async function findServer(name) {
  const { servers } = await loadServers();
  const spec = servers.find((s) => s.name === name);
  if (!spec) throw new Error(`Unknown server "${name}".`);
  return spec;
}

app.get(
  "/api/servers",
  route(async () => {
    const { servers, problems } = await loadServers();
    return {
      problems,
      servers: servers.map((s) => ({ ...s, env: Object.keys(s.env), ...mcp.sessionState(s.name) })),
    };
  })
);

app.post(
  "/api/servers/:name/connect",
  route(async (req) => {
    const spec = await findServer(req.params.name);
    const state = await mcp.connect(spec, req.user.sub);
    return { ...state, ...(await mcp.inventory(spec.name)) };
  })
);

app.post(
  "/api/servers/:name/disconnect",
  route(async (req) => {
    await mcp.disconnect(req.params.name);
    return { connected: false };
  })
);

app.get(
  "/api/servers/:name/inventory",
  route(async (req) => mcp.inventory(req.params.name))
);

app.post(
  "/api/servers/:name/call",
  route(async (req) => {
    const { tool, args, replayOf } = req.body ?? {};
    if (!tool) throw new Error("Request body must include a \"tool\" name.");
    const call = await mcp.callTool(req.params.name, tool, args, {
      replayOf: replayOf ?? null,
      actor: req.user.sub,
    });
    return { ...call, log: mcp.stderrLog(req.params.name).slice(-20) };
  })
);

/* ---------- governance: approvals, policy, kill switch ---------- */

app.get(
  "/api/approvals",
  route(async () => ({ pending: approvals.listPending(), history: store.listApprovals(25) }))
);

app.post(
  "/api/approvals/:id/decide",
  route(async (req) => {
    const { approve } = req.body ?? {};
    if (typeof approve !== "boolean") throw new Error('Body must include boolean "approve".');
    return { decided: approvals.decide(req.params.id, approve, req.user.sub) };
  })
);

app.get(
  "/api/policy",
  route(async () => ({ policy: await loadPolicy() }))
);

app.post(
  "/api/kill",
  route(async () => mcp.killSwitch())
);

/* ---------- history: sessions, timeline, replay, export ---------- */

app.get(
  "/api/sessions",
  route(async (req) => ({ sessions: store.listSessions(Number(req.query.limit ?? 50)) }))
);

app.get(
  "/api/sessions/:id",
  route(async (req) => {
    const session = store.getSession(Number(req.params.id));
    if (!session) throw new Error(`No session ${req.params.id}.`);
    return { session, calls: store.listCalls(session.id) };
  })
);

/** Re-run a stored call against the live connection, linked to the original. */
app.post(
  "/api/calls/:id/replay",
  route(async (req) => {
    const original = store.getCall(Number(req.params.id));
    if (!original) throw new Error(`No call ${req.params.id}.`);
    const session = store.getSession(original.session_id);
    const call = await mcp.callTool(session.server_name, original.tool, original.args, {
      replayOf: original.id,
      actor: req.user.sub,
    });
    return { ...call, original: { id: original.id, durationMs: original.duration_ms } };
  })
);

app.get("/api/sessions/:id/export", async (req, res) => {
  try {
    const session = store.getSession(Number(req.params.id));
    if (!session) throw new Error(`No session ${req.params.id}.`);
    const calls = store.listCalls(session.id);

    if (req.query.format === "csv") {
      const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const header = "seq,tool,is_error,duration_ms,bytes_in,bytes_out,created_at,args";
      const rows = calls.map((c) =>
        [c.seq, c.tool, c.is_error, c.duration_ms, c.bytes_in, c.bytes_out, c.created_at, JSON.stringify(c.args)]
          .map(cell)
          .join(",")
      );
      res.type("text/csv").attachment(`cela-session-${session.id}.csv`).send([header, ...rows].join("\n"));
      return;
    }

    res.attachment(`cela-session-${session.id}.json`).json({ session, calls });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const staleApprovals = store.reconcilePendingApprovals();
if (staleApprovals) console.log(`Expired ${staleApprovals} approval(s) left pending by a previous run.`);

const orphans = store.reconcileOrphans();
if (orphans) console.log(`Closed ${orphans} session(s) left open by a previous run.`);

const port = Number(process.env.PORT ?? 3000);
// Default to loopback: this console spawns processes, so exposing it is opt-in.
const host = process.env.HOST ?? "127.0.0.1";

const server = app.listen(port, host, () => {
  console.log(`cela.ai MCP Console listening on http://${host}:${port}`);
  console.log(`Auth provider: ${auth.providerName}`);
  if (auth.providerName === "local" && !process.env.AUTH_TOKEN) {
    console.log(`\n  Operator token (this run only):\n  ${auth.operatorToken}\n`);
  }
  if (host !== "127.0.0.1" && !process.env.AUTH_TOKEN) {
    console.warn("  Warning: bound beyond loopback with an ephemeral token. Set AUTH_TOKEN for a stable deployment.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await mcp.shutdownAll("console shutdown");
    server.close(() => process.exit(0));
  });
}
