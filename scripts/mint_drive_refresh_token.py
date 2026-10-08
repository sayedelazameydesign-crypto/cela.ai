#!/usr/bin/env python3
"""Mint a Google Drive OAuth 2.0 refresh token for the ``/integrations`` portal.

Why this script exists alongside OAuth Playground:

1. **Exact variable names.** Generic guides emit ``GOOGLE_CLIENT_ID`` /
   ``GOOGLE_REFRESH_TOKEN``; ``backend/integrations/config.py`` reads
   ``GOOGLE_DRIVE_CLIENT_ID``, ``GOOGLE_DRIVE_CLIENT_SECRET``, and
   ``GOOGLE_DRIVE_REFRESH_TOKEN``.
2. **Exact least-privilege scopes.** ``drive.file`` alone cannot list pre-existing
   files in an operator's folder (it sees only files created by the same OAuth
   client, making a non-empty folder look empty). Full ``drive`` is over-broad.
   This script requests the exact pair documented in ``CREDENTIALS.md``:
   ``drive.readonly`` (list folder) + ``drive.file`` (create probe/text file).
3. **Zero third-party dependencies.** Built on the Python standard library with
   PKCE (S256) and CSRF ``state`` verification on a loopback listener, and never
   writes credentials to disk.

Usage::

    GOOGLE_DRIVE_CLIENT_ID=... GOOGLE_DRIVE_CLIENT_SECRET=... \\
        python3 scripts/mint_drive_refresh_token.py

    python3 scripts/mint_drive_refresh_token.py --self-test
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from typing import Callable, Mapping, Tuple

AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"

# Least-privilege pair: readonly for folder listing + drive.file for portal uploads.
SCOPES: Tuple[str, ...] = (
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
)


def pkce_pair(verifier: str | None = None) -> Tuple[str, str]:
    """Return ``(code_verifier, code_challenge)`` using RFC 7636 S256."""
    raw_verifier = verifier or secrets.token_urlsafe(48)
    digest = hashlib.sha256(raw_verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return raw_verifier, challenge


def build_authorization_url(
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str,
    scopes: Tuple[str, ...] = SCOPES,
) -> str:
    """Build the Google OAuth 2.0 consent URL for an offline refresh token."""
    cid = (client_id or "").strip()
    if not cid:
        raise ValueError("missing GOOGLE_DRIVE_CLIENT_ID")
    params = {
        "client_id": cid,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes),
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "false",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{AUTH_URI}?{urllib.parse.urlencode(params)}"


def validate_callback_query(query: str, expected_state: str) -> str:
    """Validate the OAuth redirect query string and return the authorization code."""
    parsed = urllib.parse.parse_qs(query, keep_blank_values=True)
    if "error" in parsed:
        err = parsed["error"][0]
        raise ValueError(f"OAuth consent refused by provider: {err}")
    got_state = (parsed.get("state") or [""])[0]
    if not expected_state or not secrets.compare_digest(got_state, expected_state):
        raise ValueError("OAuth state mismatch (refusing unverified callback)")
    code = (parsed.get("code") or [""])[0].strip()
    if not code:
        raise ValueError("OAuth callback carried no authorization code")
    return code


def exchange_code_for_tokens(
    *,
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    post_form: Callable[[str, bytes], Mapping[str, object]] | None = None,
) -> Mapping[str, object]:
    """Exchange an authorization code + PKCE verifier for a refresh token."""
    cid = (client_id or "").strip()
    csec = (client_secret or "").strip()
    if not cid or not csec:
        raise ValueError("both GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET are required")
    body = urllib.parse.urlencode({
        "client_id": cid,
        "client_secret": csec,
        "code": code,
        "code_verifier": code_verifier,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }).encode("utf-8")

    sender = post_form or _default_post_form
    payload = sender(TOKEN_URI, body)
    refresh = str(payload.get("refresh_token") or "").strip()
    if not refresh:
        raise ValueError(
            "Google returned no refresh_token. Revoke the previous grant at "
            "https://myaccount.google.com/permissions and run again with prompt=consent."
        )
    return payload


def _default_post_form(url: str, body: bytes) -> Mapping[str, object]:
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:200]
        raise ValueError(f"token endpoint answered HTTP {exc.code}: {detail}") from None


def format_env_block(client_id: str, client_secret: str, refresh_token: str, folder_id: str = "") -> str:
    """Format the exact variable names expected by ``backend/integrations/config.py``."""
    lines = [
        f"GOOGLE_DRIVE_CLIENT_ID={client_id.strip()}",
        f"GOOGLE_DRIVE_CLIENT_SECRET={client_secret.strip()}",
        f"GOOGLE_DRIVE_REFRESH_TOKEN={refresh_token.strip()}",
    ]
    if folder_id.strip():
        lines.append(f"GOOGLE_DRIVE_FOLDER_ID={folder_id.strip()}")
    return "\n".join(lines)


def self_test() -> int:
    """Offline verification of PKCE, consent URL, callback checks, and token exchange."""
    verifier, challenge = pkce_pair("fixed-verifier-for-deterministic-selftest-0123456789")
    assert len(challenge) >= 40 and "=" not in challenge, "S256 challenge must be unpadded base64url"

    url = build_authorization_url(
        client_id="12345-app.apps.googleusercontent.com",
        redirect_uri="http://127.0.0.1:8765/callback",
        state="state-xyz",
        code_challenge=challenge,
    )
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parsed.query)
    assert parsed.scheme == "https" and parsed.netloc == "accounts.google.com"
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]
    assert query["code_challenge_method"] == ["S256"]
    assert set(query["scope"][0].split()) == set(SCOPES), "must request both readonly and drive.file"

    # Callback validation: valid code passes; wrong state or provider error raises.
    assert validate_callback_query("code=auth-code-1&state=state-xyz", "state-xyz") == "auth-code-1"
    for bad_query in ("code=auth-code-1&state=wrong", "error=access_denied&state=state-xyz", "state=state-xyz"):
        try:
            validate_callback_query(bad_query, "state-xyz")
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {bad_query!r}")

    # Token exchange: refuses missing refresh_token; succeeds when refresh_token is present.
    try:
        exchange_code_for_tokens(
            client_id="cid",
            client_secret="csec",
            code="code-1",
            redirect_uri="http://127.0.0.1:8765/callback",
            code_verifier=verifier,
            post_form=lambda _u, _b: {"access_token": "ya29.only"},
        )
    except ValueError as exc:
        assert "refresh_token" in str(exc)
    else:
        raise AssertionError("missing refresh_token must fail loudly")

    tokens = exchange_code_for_tokens(
        client_id="cid",
        client_secret="csec",
        code="code-1",
        redirect_uri="http://127.0.0.1:8765/callback",
        code_verifier=verifier,
        post_form=lambda _u, _b: {"access_token": "ya29.ok", "refresh_token": "1//refresh-ok"},
    )
    block = format_env_block("cid", "csec", str(tokens["refresh_token"]), "folder123")
    assert "GOOGLE_DRIVE_CLIENT_ID=cid" in block
    assert "GOOGLE_DRIVE_CLIENT_SECRET=csec" in block
    assert "GOOGLE_DRIVE_REFRESH_TOKEN=1//refresh-ok" in block
    assert "GOOGLE_DRIVE_FOLDER_ID=folder123" in block
    print("mint_drive_refresh_token self-test: ok (7 checks)")
    return 0


def run_interactive(port: int, open_browser: bool) -> int:
    client_id = os.environ.get("GOOGLE_DRIVE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_DRIVE_CLIENT_SECRET", "").strip()
    folder_id = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "").strip()
    if not client_id or not client_secret:
        print(
            "Error: set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET in your environment first.",
            file=sys.stderr,
        )
        return 2

    redirect_uri = f"http://127.0.0.1:{port}/callback"
    state = secrets.token_urlsafe(24)
    verifier, challenge = pkce_pair()
    auth_url = build_authorization_url(client_id, redirect_uri, state, challenge)

    captured: dict[str, str] = {}

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            parts = urllib.parse.urlsplit(self.path)
            if parts.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            captured["query"] = parts.query
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("تم استلام رمز التفويض بنجاح. يمكنك إغلاق هذه النافذة والعودة إلى الطرفية.\n".encode("utf-8"))

        def log_message(self, format, *args):  # noqa: A002
            return  # Never log the callback query string containing the auth code.

    with http.server.HTTPServer(("127.0.0.1", port), CallbackHandler) as httpd:
        print(f"1. Add this Authorized redirect URI in Google Cloud Console:\n   {redirect_uri}\n")
        print(f"2. Open this URL in your browser to authorize:\n   {auth_url}\n")
        if open_browser:
            webbrowser.open(auth_url)
        print("Waiting for OAuth callback on 127.0.0.1...")
        while "query" not in captured:
            httpd.handle_request()

    code = validate_callback_query(captured["query"], state)
    tokens = exchange_code_for_tokens(
        client_id=client_id,
        client_secret=client_secret,
        code=code,
        redirect_uri=redirect_uri,
        code_verifier=verifier,
    )
    print("\n# Add these variables to Render / Vercel / GitHub Secrets (never commit them):")
    print(format_env_block(client_id, client_secret, str(tokens["refresh_token"]), folder_id))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Run offline unit checks and exit")
    parser.add_argument("--port", type=int, default=8765, help="Loopback port for OAuth callback (default: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="Print the consent URL without opening a browser")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    return run_interactive(port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    raise SystemExit(main())
