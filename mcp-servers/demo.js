#!/usr/bin/env node
/**
 * cela.ai demo MCP server (stdio).
 *
 * A tiny, dependency-light MCP server used to exercise the console end-to-end
 * without needing credentials for a real provider. It exposes read-only tools
 * scoped to this repository.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IGNORED = new Set(["node_modules", ".git"]);

/** Resolve a user-supplied path, refusing anything outside the repo root. */
function safeResolve(relative) {
  const target = path.resolve(ROOT, relative ?? ".");
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    throw new Error(`Path escapes the repository root: ${relative}`);
  }
  return target;
}

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const server = new McpServer({ name: "cela-demo", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Return the message you send, unchanged. Useful as a connectivity check.",
    inputSchema: { message: z.string().describe("Text to echo back") },
  },
  async ({ message }) => text(message)
);

server.registerTool(
  "list_files",
  {
    title: "List files",
    description: "List files and directories inside this repository.",
    inputSchema: {
      dir: z.string().optional().describe("Directory relative to the repo root (default: root)"),
    },
  },
  async ({ dir }) => {
    const target = safeResolve(dir);
    const entries = await readdir(target, { withFileTypes: true });
    const rows = entries
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`)
      .sort();
    return text(rows.join("\n") || "(empty)");
  }
);

server.registerTool(
  "read_file",
  {
    title: "Read file",
    description: "Read a UTF-8 text file from this repository (max 64 KB).",
    inputSchema: { file: z.string().describe("File path relative to the repo root") },
  },
  async ({ file }) => {
    const target = safeResolve(file);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Not a file: ${file}`);
    if (info.size > 64 * 1024) throw new Error(`File too large (${info.size} bytes, limit 65536)`);
    return text(await readFile(target, "utf8"));
  }
);

server.registerTool(
  "repo_summary",
  {
    title: "Repository summary",
    description: "Count files and report which MCP configuration files this repo declares.",
    inputSchema: {},
  },
  async () => {
    let files = 0;
    let dirs = 0;
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (IGNORED.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          dirs += 1;
          await walk(full);
        } else {
          files += 1;
        }
      }
    };
    await walk(ROOT);

    const configs = [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", "mcp.local.json"];
    const present = [];
    for (const rel of configs) {
      try {
        await stat(path.join(ROOT, rel));
        present.push(rel);
      } catch {
        /* missing is fine */
      }
    }
    return text({ root: ROOT, files, directories: dirs, mcpConfigs: present });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
