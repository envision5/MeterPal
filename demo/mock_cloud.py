# demo/mock_cloud.py - local stand-in for the two cloud services MeterPal's
# dashboard talks to at sign-in: Google OAuth and the Resend email API.
#
#   python demo/mock_cloud.py        (the stack starts this on :9998)
#
# Why: the local stack has no Google OAuth app and no mail provider, so
# "Continue with Google" and email OTP would dead-end.  This server gives the
# developer (and a hackathon judge) both flows with zero external setup:
#
#   Google   - GET  /o/oauth2/v2/auth   account chooser (MeterPal-branded);
#              any email can sign in, including seeded demo accounts
#              GET  /v3/userinfo          profile for the chosen account
#              POST /oauth2/token         code -> tokens (nothing verifies
#                                         them: auth.ts sets verifyIdToken)
#   Resend   - POST /emails             accepts the SDK's payload, renders it
#              GET  /inbox                web inbox at http://localhost:9998/inbox
#
# The billing server's auth.ts rewrites Google's token/userinfo hosts onto
# this server when EMULATE_GOOGLE_URL is set; resendUtils honors
# RESEND_BASE_URL the same way.  Both are wired in billing/server/.env.

import base64
import hashlib
import hmac
import html
import json
import re
import secrets
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 9998

# Seeded demo accounts get top billing on the chooser; any other email works.
DEMO_ACCOUNTS = [
    ("merchant@meterpal.dev", "Merchant Owner", "Demo Org"),
    ("capy@autumn.test", "Capy Admin", "Demo Org"),
]

JWT_SECRET = b"mock-cloud-secret"
_tokens = {}  # access_token -> email
_codes = {}  # authorization code -> email
_messages = []  # Resend inbox: {id, to, subject, html, text, ts}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _make_id_token(email: str) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(
        json.dumps(
            {
                "sub": email,
                "email": email,
                "email_verified": True,
                "name": email.split("@")[0],
                "iat": int(time.time()),
                "exp": int(time.time()) + 3600,
                "aud": "mock-google-client",
            }
        ).encode()
    )
    sig = _b64url(hmac.new(JWT_SECRET, f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def _extract_otp(message: dict) -> str | None:
    for key in ("html", "text"):
        value = message.get(key)
        if not value:
            continue
        match = re.search(r"\b(\d{6})\b", str(value))
        if match:
            return match.group(1)
    return None


PAGE = """<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>MeterPal - choose an account</title>
<style>
  body {{ margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
         background: linear-gradient(160deg, #0d1b3d 10%, #264082 55%, #1a2c5c 100%);
         min-height: 100vh; display: flex; align-items: center; justify-content: center; }}
  .card {{ background: #fff; border-radius: 14px; padding: 32px; width: 380px;
          box-shadow: 0 24px 60px rgba(0,0,0,.4); }}
  h1 {{ font-size: 17px; margin: 0 0 4px; color: #121212; }}
  p.sub {{ margin: 0 0 20px; font-size: 13px; color: #666; }}
  a.acct {{ display: flex; align-items: center; gap: 12px; padding: 12px 14px;
           border: 1px solid #e5e5e5; border-radius: 10px; margin-bottom: 10px;
           text-decoration: none; color: #121212; font-size: 14px; }}
  a.acct:hover {{ background: #f0f4fc; border-color: #264082; }}
  .avatar {{ width: 34px; height: 34px; border-radius: 50%; background: #264082;
            color: #fff; display: flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 15px; flex-shrink: 0; }}
  .org {{ display: block; font-size: 12px; color: #888; }}
  form.other {{ display: flex; gap: 8px; margin-top: 16px; }}
  input {{ flex: 1; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px;
          font-size: 13px; }}
  button {{ background: #264082; color: #fff; border: 0; border-radius: 8px;
           padding: 10px 14px; font-size: 13px; cursor: pointer; }}
  .brand {{ text-align: center; margin-bottom: 18px; font-weight: 800; font-size: 15px;
           color: #264082; letter-spacing: -0.2px; }}
  .note {{ font-size: 11px; color: #999; margin-top: 14px; text-align: center; }}
</style>
</head>
<body>
  <div class="card">
    <div class="brand">MeterPal &middot; local Google</div>
    <h1>Choose an account</h1>
    <p class="sub">to continue to MeterPal (localhost dev sign-in)</p>
    {accounts}
    <form class="other" method="get" action="/o/oauth2/choose">
      {hidden}
      <input name="email" placeholder="or type any email" required />
      <button>Continue</button>
    </form>
    <div class="note">Local OAuth emulation - no real Google account is used.</div>
  </div>
</body>
</html>"""

INBOX_PAGE = """<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="3" />
<title>MeterPal local inbox</title>
<style>
  body {{ margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #121212; color: #ddd; }}
  header {{ background: #264082; color: #fff; padding: 14px 22px; font-weight: 700; }}
  header span {{ color: #f4bf3d; }}
  .wrap {{ max-width: 760px; margin: 24px auto; padding: 0 16px; }}
  .otp {{ background: #f4bf3d; color: #121212; font-size: 34px; font-weight: 800;
         padding: 18px; border-radius: 12px; text-align: center; margin-bottom: 20px;
         letter-spacing: 6px; }}
  .msg {{ background: #1d1d1d; border: 1px solid #262626; border-radius: 10px;
         padding: 14px 16px; margin-bottom: 10px; }}
  .msg a {{ color: #00bfe4; text-decoration: none; font-size: 14px; }}
  .meta {{ color: #888; font-size: 12px; margin-top: 4px; }}
  pre {{ white-space: pre-wrap; font-size: 13px; color: #ccc; }}
  .empty {{ color: #888; text-align: center; padding: 40px 0; }}
</style>
</head>
<body>
  <header>MeterPal local inbox &mdash; <span>everything the stack "emails" lands here</span></header>
  <div class="wrap">
    {content}
  </div>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[mock-cloud]", fmt % args)

    # ---- helpers -------------------------------------------------------
    def _send(self, status, body, content_type="text/html; charset=utf-8", headers=None):
        payload = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj), "application/json")

    def _redirect(self, location):
        self._send(302, "", headers={"Location": location})

    # ---- Google emulation ---------------------------------------------
    def _auth_page(self, query):
        params = urllib.parse.parse_qs(query)
        # Preserve every OAuth param the backend sent.
        carry = {
            k: v[0]
            for k, v in params.items()
            if k not in ("email",) and v
        }
        hidden = "".join(
            f'<input type="hidden" name="{html.escape(k)}" value="{html.escape(v)}" />'
            for k, v in carry.items()
        )
        rows = []
        for email, name, org in DEMO_ACCOUNTS:
            qs = urllib.parse.urlencode({**carry, "email": email})
            rows.append(
                f'<a class="acct" href="/o/oauth2/choose?{qs}">'
                f'<span class="avatar">{html.escape(name[0])}</span>'
                f"<span>{html.escape(email)}<span class='org'>{html.escape(org)}</span></span></a>"
            )
        self._send(200, PAGE.format(accounts="".join(rows), hidden=hidden))

    def _choose(self, query):
        params = urllib.parse.parse_qs(query)
        email = (params.get("email") or [""])[0].strip().lower()
        redirect_uri = (params.get("redirect_uri") or [""])[0]
        if not email or not redirect_uri:
            self._send(400, "missing email or redirect_uri")
            return
        code = secrets.token_urlsafe(16)
        _codes[code] = email
        sep = "&" if "?" in redirect_uri else "?"
        self._redirect(f"{redirect_uri}{sep}code={urllib.parse.quote(code)}&state={urllib.parse.quote((params.get('state') or [''])[0])}")

    def _token(self, body):
        form = urllib.parse.parse_qs(body)
        code = (form.get("code") or [""])[0]
        email = _codes.pop(code, "merchant@meterpal.dev")
        access = secrets.token_urlsafe(24)
        _tokens[access] = email
        self._json(
            200,
            {
                "access_token": access,
                "id_token": _make_id_token(email),
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": "openid email profile",
            },
        )

    def _userinfo(self):
        auth = self.headers.get("Authorization", "")
        token = auth.replace("Bearer ", "").strip()
        email = _tokens.get(token)
        if not email:
            self._json(401, {"error": "invalid_token"})
            return
        self._json(
            200,
            {
                "sub": email,
                "email": email,
                "email_verified": True,
                "name": email.split("@")[0].replace(".", " ").title(),
                "picture": "",
            },
        )

    # ---- Resend emulation ----------------------------------------------
    def _receive_email(self, body):
        try:
            payload = json.loads(body)
        except Exception:
            self._json(400, {"error": "invalid json"})
            return
        message = {
            "id": "mock-" + secrets.token_hex(6),
            "to": payload.get("to"),
            "from": payload.get("from"),
            "subject": payload.get("subject", "(no subject)"),
            "html": payload.get("html"),
            "text": payload.get("text"),
            "ts": time.strftime("%H:%M:%S"),
        }
        _messages.insert(0, message)
        print(f"[mock-cloud] email -> {message['to']}: {message['subject']} otp={_extract_otp(message)}")
        self._json(200, {"id": message["id"]})

    def _inbox(self):
        if not _messages:
            content = '<div class="empty">No mail yet. Trigger an email OTP sign-in from the dashboard.</div>'
        else:
            parts = []
            latest_otp = next(
                (_extract_otp(m) for m in _messages if _extract_otp(m)), None
            )
            if latest_otp:
                parts.append(f'<div class="otp">Latest code: {latest_otp}</div>')
            for m in _messages[:12]:
                body_text = html.escape(
                    re.sub(r"<[^>]+>", " ", m.get("html") or m.get("text") or "")[:400]
                )
                parts.append(
                    f'<div class="msg"><a href="/inbox?view={m["id"]}">{html.escape(m["subject"])}</a>'
                    f'<div class="meta">to {html.escape(str(m["to"]))} &middot; {m["ts"]} &middot; from {html.escape(str(m["from"]))}</div>'
                    f"<pre>{body_text}</pre></div>"
                )
            content = "".join(parts)
        self._send(200, INBOX_PAGE.format(content=content))

    # ---- routing --------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, parsed.query
        if path == "/health":
            self._json(200, {"ok": True, "service": "mock-cloud"})
        elif path == "/o/oauth2/v2/auth":
            self._auth_page(query)
        elif path == "/o/oauth2/choose":
            self._choose(query)
        elif path == "/v3/userinfo" or path == "/userinfo":
            self._userinfo()
        elif path == "/inbox":
            self._inbox()
        elif path == "/emails":
            self._json(200, {"data": _messages[:20]})
        else:
            self._send(404, "mock-cloud: unknown path")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
        if parsed.path == "/oauth2/token":
            self._token(body)
        elif parsed.path == "/emails":
            self._receive_email(body)
        else:
            self._send(404, "mock-cloud: unknown path")


if __name__ == "__main__":
    print(f"mock-cloud: Google OAuth emulation + Resend inbox on http://localhost:{PORT}")
    print(f"  inbox: http://localhost:{PORT}/inbox")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
