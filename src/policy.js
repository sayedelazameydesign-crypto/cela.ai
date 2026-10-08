/**
 * Policy evaluation: decide allow / approve / deny *before* a tool runs.
 *
 * Rules come from policy.json and are re-read on each evaluation so an operator
 * can tighten policy without restarting a live console.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./config.js";

const DEFAULTS = {
  default: { action: "allow" },
  rules: [],
  sessionLimits: { maxCalls: 200, maxPayloadBytes: 5 * 1024 * 1024 },
  approvalTimeoutMs: 120_000,
};

export async function loadPolicy() {
  try {
    const raw = JSON.parse(await readFile(path.join(ROOT, "policy.json"), "utf8"));
    return { ...DEFAULTS, ...raw };
  } catch (err) {
    if (err.code === "ENOENT") return DEFAULTS;
    throw new Error(`policy.json is invalid: ${err.message}`);
  }
}

function matches(rule, { server, tool }) {
  const m = rule.match ?? {};
  if (m.server && m.server !== server) return false;
  if (m.tool && m.tool !== tool) return false;
  if (m.toolPattern && !new RegExp(m.toolPattern, "i").test(tool)) return false;
  return Boolean(m.server || m.tool || m.toolPattern);
}

/** Specificity: an exact tool name beats a pattern, and a server qualifier adds weight. */
const score = (rule) => (rule.match?.tool ? 4 : 0) + (rule.match?.toolPattern ? 2 : 0) + (rule.match?.server ? 1 : 0);

/**
 * @param stats {{calls:number, payloadBytes:number, callsByTool:Record<string,number>}}
 * @returns {{action:'allow'|'approve'|'deny', reason:string, rule:object|null}}
 */
export function evaluate(policy, { server, tool }, stats) {
  const limits = policy.sessionLimits ?? {};

  if (limits.maxCalls && stats.calls >= limits.maxCalls) {
    return { action: "deny", reason: `Session call limit reached (${limits.maxCalls}).`, rule: null };
  }
  if (limits.maxPayloadBytes && stats.payloadBytes >= limits.maxPayloadBytes) {
    return {
      action: "deny",
      reason: `Session payload limit reached (${limits.maxPayloadBytes} bytes).`,
      rule: null,
    };
  }

  const rule = (policy.rules ?? [])
    .filter((r) => matches(r, { server, tool }))
    .sort((a, b) => score(b) - score(a))[0];

  if (!rule) {
    return { action: policy.default?.action ?? "allow", reason: "Default policy.", rule: null };
  }

  const perTool = rule.limits?.maxCallsPerSession;
  if (perTool && (stats.callsByTool[tool] ?? 0) >= perTool) {
    return {
      action: "deny",
      reason: `"${tool}" exceeded its per-session limit of ${perTool} calls.`,
      rule,
    };
  }

  return { action: rule.action ?? "allow", reason: rule.reason ?? "Matched policy rule.", rule };
}
