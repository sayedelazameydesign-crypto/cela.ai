# Identity

Every `/api/*` route requires an identity. Nothing in this console acts
anonymously any more, and every session, call and approval decision is
attributed to a subject.

## Why this came before hash-chaining

An audit log that says *"someone approved `write_file`"* is a debug log. Signing
it protects a sentence that identifies nobody. The log becomes evidence only
once it says *"`ahmed@example.com` approved `write_file`"* — so identity lands
first, and the chain is designed around it rather than retrofitted (see
`AUDIT_FIELDS` / `canonicalAuditRow()` in `src/db.js`).

## Providers

`src/auth.js` is a provider interface, not a vendor integration.

### `local` (default, implemented)

A single operator proves possession of a token.

```bash
AUTH_TOKEN=$(openssl rand -hex 16) npm start   # stable token
npm start                                      # ephemeral token, printed at startup
```

- Session = HMAC-signed cookie (`HttpOnly`, `SameSite=Lax`, 12 h), `node:crypto`
  only, no new dependencies.
- Signing key: `AUTH_SECRET`, else `data/session-secret` (mode 600, generated once).
- Token comparison uses fixed-length digests, so neither value nor length leaks
  via timing. A forged cookie payload fails signature verification (verified: 401).
- Set `COOKIE_SECURE=true` when serving over HTTPS.

**Binding.** The console spawns processes, so it defaults to `127.0.0.1`.
Exposure is opt-in via `HOST=0.0.0.0`, and the server warns if you do that with
an ephemeral token.

### `oidc` (not implemented — contract)

To add it, implement one function and nothing else changes:

```js
login(credential) -> { sub, name }   // sub must be stable and globally unique
```

Plus two routes for the redirect dance (`/api/auth/start`, `/api/auth/callback`),
exchanging the code for an ID token and mapping claims to `{ sub, name }`.
`issueSession` / `requireAuth` / the audit columns stay as they are.

**On choosing a provider.** Auth0 appearing in this repo is not an architectural
reason to adopt it. For a console on one developer's machine, `local` is
right-sized. For an internal network service, any OIDC provider works — Auth0 if
the team already pays for it, Keycloak or dex if a self-hosted, dependency-free
deployment matters more.

## Deliberately absent: roles

There is no RBAC, and that is the point. Real identities have to exist before
roles can be observed rather than guessed — `operator` is unlikely to survive
contact with reality, because approving `read_file`, approving `write_file`,
reading the audit log and killing sessions are four different privileges that
rarely belong to one role.

What exists now is the prerequisite: a stable `sub` on every session, call and
approval. Roles become a lookup from `sub`, and `policy.json` rules gain an
optional `role` qualifier — an additive change, no migration.

## Threat model, stated plainly

- **Protects against:** another user or process on the host driving the console,
  and anyone on the network if you bind beyond loopback.
- **Does not protect against:** anyone who can read `data/session-secret` or the
  process environment — they can mint sessions. Same-host root is out of scope.
- **Audit rows are not yet tamper-evident.** An attacker with write access to
  `data/cela.db` can rewrite history. That is what hash-chaining fixes, and it
  is now the next task.
