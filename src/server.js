import express from "express";
import path from "node:path";
import { loadServers, ROOT } from "./config.js";
import * as mcp from "./mcp-manager.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

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
    const state = await mcp.connect(spec);
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
    const { tool, args } = req.body ?? {};
    if (!tool) throw new Error("Request body must include a \"tool\" name.");
    const started = Date.now();
    const result = await mcp.callTool(req.params.name, tool, args);
    return { result, durationMs: Date.now() - started, log: mcp.stderrLog(req.params.name).slice(-20) };
  })
);

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`cela.ai MCP Console listening on http://0.0.0.0:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await mcp.shutdownAll();
    server.close(() => process.exit(0));
  });
}
