import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Config files this console understands.
 * `key` is the top-level property holding the server map, which differs per client.
 */
const SOURCES = [
  { file: ".mcp.json", key: "mcpServers", client: "Claude Code" },
  { file: ".cursor/mcp.json", key: "mcpServers", client: "Cursor" },
  { file: ".vscode/mcp.json", key: "servers", client: "VS Code" },
  { file: "mcp.local.json", key: "mcpServers", client: "local" },
];

async function readJson(file) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, file), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`${file}: ${err.message}`);
  }
}

/**
 * Load every declared stdio server, de-duplicated by name.
 * The same server declared in several files is reported once, listing each source.
 */
export async function loadServers() {
  const byName = new Map();
  const problems = [];

  for (const source of SOURCES) {
    let doc;
    try {
      doc = await readJson(source.file);
    } catch (err) {
      problems.push(err.message);
      continue;
    }
    if (!doc) continue;

    const map = doc[source.key] ?? {};
    for (const [name, raw] of Object.entries(map)) {
      if (raw?.url || raw?.type === "http" || raw?.type === "sse") {
        problems.push(`${source.file}: "${name}" is a remote server; this console only launches stdio servers.`);
        continue;
      }
      if (!raw?.command) {
        problems.push(`${source.file}: "${name}" has no "command".`);
        continue;
      }

      const existing = byName.get(name);
      if (existing) {
        existing.sources.push(source.file);
        continue;
      }
      byName.set(name, {
        name,
        command: raw.command,
        args: raw.args ?? [],
        env: raw.env ?? {},
        sources: [source.file],
        client: source.client,
      });
    }
  }

  return { servers: [...byName.values()], problems };
}
