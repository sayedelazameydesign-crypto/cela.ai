/**
 * Operator identity.
 *
 * Deliberately a *provider interface*, not an Auth0 integration. Today one
 * provider ships:
 *
 *   local  — a single operator proves possession of a token printed at startup.
 *            Right-sized for a console bound to a developer's machine.
 *   oidc   — not implemented. See docs/auth.md for the contract it must satisfy.
 *            Nothing above this module needs to change when it lands.
 *
 * Sessions are HMAC-signed cookies (node:crypto only — no new dependencies).
 * There are no roles yet, on purpose: roles invented before real identities are
 * roles you will have to migrate.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const COOKIE = "cela_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const dataDir = path.join(ROOT, "data");

function persistentSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "session-secret");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

const SECRET = persistentSecret();

/** The shared operator token. Generated once per boot unless pinned via env. */
export const operatorToken = process.env.AUTH_TOKEN ?? randomBytes(16).toString("hex");
export const providerName = process.env.AUTH_PROVIDER ?? "local";

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload) => createHmac("sha256", SECRET).update(payload).digest("base64url");

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function issueSession({ sub, name }) {
  const payload = b64(JSON.stringify({ sub, name, exp: Date.now() + SESSION_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

export function verifySession(value) {
  if (!value || !value.includes(".")) return null;
  const [payload, mac] = value.split(".");
  if (!safeEqual(sign(payload), mac)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims.exp || claims.exp < Date.now()) return null;
    return { sub: claims.sub, name: claims.name };
  } catch {
    return null;
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([k, v]) => k && v)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])
  );
}

/** Exchange a provider credential for an identity. */
export function login({ token }) {
  if (providerName !== "local") {
    throw new Error(`Auth provider "${providerName}" is not implemented. See docs/auth.md.`);
  }
  // Compare fixed-length digests so neither the value nor its length leaks via timing.
  const digest = (value) => createHmac("sha256", SECRET).update(String(value)).digest();
  if (typeof token !== "string" || !timingSafeEqual(digest(token), digest(operatorToken))) {
    throw new Error("Invalid operator token.");
  }
  return { sub: "local:operator", name: "operator" };
}

export function setSessionCookie(res, session) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Express middleware: attach req.user, or 401. */
export function requireAuth(req, res, next) {
  const user = verifySession(parseCookies(req.headers.cookie).cela_session);
  if (!user) {
    res.status(401).json({ error: "Authentication required.", provider: providerName });
    return;
  }
  req.user = user;
  next();
}

export function currentUser(req) {
  return verifySession(parseCookies(req.headers.cookie).cela_session);
}
