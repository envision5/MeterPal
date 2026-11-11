# demo/mock_paypal.py - local stand-in for the PayPal Invoicing REST API v2.
#
#   python demo/mock_paypal.py        (the stack starts this on :9997)
#
# Why: the sandbox app in billing/server/.env does not have the Invoicing
# scope, so every /v2/invoicing/* call answers 403 NOT_AUTHORIZED and the
# overage-invoice flow cannot be exercised.  Point PAYPAL_BASE_URL at this
# server and the whole loop runs offline.
#
# The shapes here are taken from the published reference, not invented:
#   POST /v2/invoicing/invoices              -> 201, {id, status:"DRAFT", ...,
#                                               detail.metadata.recipient_view_url}
#   POST /v2/invoicing/invoices/{id}/send    -> 200, {href, rel, method}
#                                               (a LINK, not the invoice)
#   GET  /v2/invoicing/invoices/{id}         -> 200, the invoice
#   GET  /v2/invoicing/invoices              -> 200, {total_items, items}
#   POST /v2/invoicing/invoices/{id}/refunds -> 200, {refund_id}
#   POST /v2/invoicing/invoices/{id}/remind  -> 204
#   POST /v2/invoicing/invoices/{id}/cancel  -> 204
#
# Mock-only control surface, so a demo can act as the buyer:
#   POST /_mock/pay/{id}      mark an invoice PAID and print the webhook body
#   GET  /_mock/invoices      dump state
#   GET  /pay/{id}            the payer-facing page (the view URL target)
#
# Everything that is NOT /v2/invoicing/* is transparently proxied to the real
# PayPal host (PAYPAL_UPSTREAM, default the sandbox).  That matters: the
# billing server uses one base URL for every PayPal call, so a mock that
# swallowed orders/subscriptions would break checkout.  With the proxy, only
# invoicing is emulated and the rest of the rail stays real.
#
# Spec: https://developer.paypal.com/api/invoicing/v2/

import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 9997
UPSTREAM = os.environ.get("PAYPAL_UPSTREAM", "https://api-m.sandbox.paypal.com")
STATE_FILE = Path(__file__).parent / "logs" / "mock_paypal.json"

_lock = threading.Lock()
_state = {"invoices": {}, "request_ids": {}}


def _load():
    global _state
    if STATE_FILE.exists():
        try:
            _state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass


def _save():
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(_state, indent=2), encoding="utf-8")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _money(value: str, currency: str = "USD") -> dict:
    return {"currency_code": currency, "value": value}


def _new_id() -> str:
    raw = secrets.token_hex(8).upper()
    return "INV2-" + "-".join(raw[i : i + 4] for i in range(0, 16, 4))


PAYER_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<title>PayPal invoice {id}</title>
<style>body{{font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 24px}}
.card{{border:1px solid #ddd;border-radius:12px;padding:28px}}
.row{{display:flex;justify-content:space-between;padding:6px 0}}
.total{{font-size:26px;font-weight:600;margin:18px 0}}
button{{background:#0070ba;color:#fff;border:0;border-radius:8px;padding:12px 22px;
font-size:15px;cursor:pointer}}small{{color:#666}}</style></head><body>
<div class="card">
<small>Mock PayPal &middot; invoice {id}</small>
<h2>{business}</h2>
<div class="row"><span>{item}</span><span>{amount}</span></div>
<div class="row"><span>Status</span><span>{status}</span></div>
<div class="row"><span>Due</span><span>{due}</span></div>
<div class="total">{amount} {currency}</div>
<form method="POST" action="/_mock/pay/{id}"><button type="submit">Pay now (mock)</button></form>
</div></body></html>"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"mock-paypal: {fmt % args}")

    # ---- helpers --------------------------------------------------------
    def _json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _empty(self, status: int = 204) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _html(self, status: int, text: str) -> None:
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        # `_raw` is drained once per request in do_POST: an unread body would
        # stay in the keep-alive socket and corrupt the next request line.
        raw = (getattr(self, "_raw", b"") or b"").decode("utf-8", "replace")
        try:
            return json.loads(raw or "{}")
        except json.JSONDecodeError:
            return {}

    def _host(self) -> str:
        return self.headers.get("Host") or f"localhost:{PORT}"

    def _view_url(self, invoice_id: str) -> str:
        return f"http://{self._host()}/pay/{invoice_id}"

    def _proxy(self, method: str) -> None:
        """Relay a non-invoicing call to the real PayPal host."""
        payload = getattr(self, "_raw", b"") or None
        # Drop accept-encoding: the relay does not forward Content-Encoding
        # back, so a compressed upstream body would reach the client labelled
        # as JSON and fail to parse.
        headers = {
            k: v
            for k, v in self.headers.items()
            if k.lower()
            not in {"host", "content-length", "connection", "accept-encoding"}
        }
        req = urllib.request.Request(
            UPSTREAM + self.path, data=payload, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                raw = res.read()
                status = res.status
                ctype = res.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            status = exc.code
            ctype = exc.headers.get("Content-Type", "application/json")
        except Exception as exc:  # upstream unreachable
            # The OAuth handshake is the one call the invoicing flow cannot
            # do without, and the sandbox egress proxy is not always
            # reachable from here. Mint a local token so invoicing still
            # works offline; a real token is only needed by the proxied
            # orders/subscriptions calls, which are unusable anyway when
            # upstream is down.
            if self.path.startswith("/v1/oauth2/token"):
                print(f"mock-paypal: upstream unreachable ({exc}); issuing local token")
                return self._json(
                    200,
                    {
                        "access_token": "mock-local-token",
                        "token_type": "Bearer",
                        "expires_in": 32400,
                        "app_id": "APP-MOCK-OFFLINE",
                    },
                )
            return self._json(
                502, {"name": "MOCK_PROXY_ERROR", "message": str(exc)[:300]}
            )
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    # ---- invoicing ------------------------------------------------------
    def _create(self) -> None:
        body = self._body()
        detail = body.get("detail") or {}
        items = body.get("items") or []
        if not detail.get("currency_code"):
            return self._json(
                400,
                {
                    "name": "INVALID_REQUEST",
                    "message": "detail.currency_code is required",
                },
            )
        if not items:
            return self._json(
                400, {"name": "INVALID_REQUEST", "message": "items is required"}
            )

        # PayPal-Request-Id dedupes a retried create for 72h.
        request_id = self.headers.get("PayPal-Request-Id")
        if request_id:
            existing = _state["request_ids"].get(request_id)
            if existing and existing in _state["invoices"]:
                return self._json(200, _state["invoices"][existing])

        # PayPal rejects a reused invoice_number, so a caller that derives the
        # number from the customer (instead of from something unique) breaks on
        # its second invoice. Mirror that here so tests catch it.
        invoice_number = detail.get("invoice_number")
        if invoice_number:
            for other in _state["invoices"].values():
                if (other.get("detail") or {}).get("invoice_number") == invoice_number:
                    return self._json(
                        422,
                        {
                            "name": "UNPROCESSABLE_ENTITY",
                            "message": "Invoice number already exists",
                            "details": [
                                {
                                    "issue": "DUPLICATE_INVOICE_NUMBER",
                                    "field": "detail.invoice_number",
                                    "value": invoice_number,
                                }
                            ],
                        },
                    )

        total = sum(
            float(i["unit_amount"]["value"]) * float(i.get("quantity") or 1)
            for i in items
        )
        value = f"{total:.2f}"
        invoice_id = _new_id()
        recipients = body.get("primary_recipients") or []
        invoice = {
            "id": invoice_id,
            "status": "DRAFT",
            "detail": {
                **detail,
                "invoice_number": detail.get("invoice_number") or invoice_id,
                "metadata": {
                    "create_time": _now(),
                    "recipient_view_url": self._view_url(invoice_id),
                    "invoicer_view_url": f"http://{self._host()}/pay/{invoice_id}",
                },
            },
            "invoicer": body.get("invoicer") or {},
            "primary_recipients": recipients,
            "items": items,
            "amount": {
                "currency_code": detail["currency_code"],
                "value": value,
                "breakdown": {"item_total": _money(value, detail["currency_code"])},
            },
            "due_amount": _money(value, detail["currency_code"]),
            "payments": {"paid_amount": _money("0.00", detail["currency_code"])},
            "links": [
                {
                    "href": f"http://{self._host()}/v2/invoicing/invoices/{invoice_id}",
                    "rel": "self",
                    "method": "GET",
                },
                {
                    "href": f"http://{self._host()}/v2/invoicing/invoices/{invoice_id}/send",
                    "rel": "send",
                    "method": "POST",
                },
            ],
        }
        with _lock:
            _state["invoices"][invoice_id] = invoice
            if request_id:
                _state["request_ids"][request_id] = invoice_id
            _save()
        self._json(201, invoice)

    def _send_invoice(self, invoice_id: str) -> None:
        with _lock:
            invoice = _state["invoices"].get(invoice_id)
            if not invoice:
                return self._json(404, {"name": "RESOURCE_NOT_FOUND"})
            if invoice["status"] != "DRAFT":
                return self._json(
                    422,
                    {
                        "name": "UNPROCESSABLE_ENTITY",
                        "message": f"Invoice status {invoice['status']} cannot be sent",
                    },
                )
            invoice["status"] = "SENT"
            invoice["detail"].setdefault("metadata", {})["send_time"] = _now()
            _save()
        # The real endpoint answers with a LINK, never the invoice.
        self._json(
            200,
            {
                "href": f"http://{self._host()}/v2/invoicing/invoices/{invoice_id}",
                "rel": "self",
                "method": "GET",
            },
        )

    def _list(self, query: str) -> None:
        params = urllib.parse.parse_qs(query)
        page = int((params.get("page") or ["1"])[0])
        size = int((params.get("page_size") or ["20"])[0])
        items = list(_state["invoices"].values())
        start = (page - 1) * size
        self._json(
            200,
            {
                "total_items": len(items),
                "total_pages": max(1, (len(items) + size - 1) // size),
                "items": items[start : start + size],
            },
        )

    def _refund(self, invoice_id: str) -> None:
        body = self._body()
        amount = (body.get("amount") or {}).get("value")
        if not amount:
            return self._json(
                400, {"name": "INVALID_REQUEST", "message": "amount is required"}
            )
        with _lock:
            invoice = _state["invoices"].get(invoice_id)
            if not invoice:
                return self._json(404, {"name": "RESOURCE_NOT_FOUND"})
            refund_id = "EXTR-" + secrets.token_hex(8).upper()
            invoice.setdefault("refunds", {}).setdefault("refunds", []).append(
                {
                    "refund_id": refund_id,
                    "amount": _money(amount),
                    "refund_date": body.get("refund_date") or _now()[:10],
                    "method": body.get("method"),
                }
            )
            total = float(invoice["amount"]["value"])
            refunded = sum(
                float(r["amount"]["value"])
                for r in invoice["refunds"]["refunds"]
            )
            invoice["status"] = (
                "REFUNDED" if refunded >= total else "PARTIALLY_REFUNDED"
            )
            _save()
        self._json(200, {"refund_id": refund_id})

    def _pay(self, invoice_id: str) -> None:
        with _lock:
            invoice = _state["invoices"].get(invoice_id)
            if not invoice:
                return self._json(404, {"name": "RESOURCE_NOT_FOUND"})
            invoice["status"] = "PAID"
            invoice["due_amount"] = _money("0.00")
            invoice["payments"] = {
                "paid_amount": _money(invoice["amount"]["value"]),
                "transactions": [
                    {
                        "id": "TXN-" + secrets.token_hex(6).upper(),
                        "type": "PAYMENT",
                        "method": "PAYPAL",
                        "amount": _money(invoice["amount"]["value"]),
                    }
                ],
            }
            _save()
            event = {
                "id": "WH-" + secrets.token_hex(8).upper(),
                "event_type": "INVOICING.INVOICE.PAID",
                "resource": invoice,
            }
        print("\nmock-paypal: invoice paid -> webhook payload (POST to your webhook route):")
        print(json.dumps(event, indent=2)[:4000], "\n")
        Path(STATE_FILE.parent / "mock_paypal_last_event.json").write_text(
            json.dumps(event, indent=2), encoding="utf-8"
        )
        self._html(200, f"<p>Paid {invoice_id}. Webhook payload saved to "
                        f"demo/logs/mock_paypal_last_event.json</p>")

    # ---- routing --------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        parts = [p for p in path.split("/") if p]

        if path == "/health":
            return self._json(200, {"ok": True, "service": "mock-paypal"})
        if path == "/_mock/invoices":
            return self._json(200, _state)
        if len(parts) == 2 and parts[0] == "pay":
            invoice = _state["invoices"].get(parts[1])
            if not invoice:
                return self._html(404, "unknown invoice")
            item = (invoice.get("items") or [{}])[0].get("name", "Invoice")
            return self._html(
                200,
                PAYER_PAGE.format(
                    id=invoice["id"],
                    business=(invoice.get("invoicer") or {}).get(
                        "business_name", "MeterPal"
                    ),
                    item=item,
                    amount=invoice["amount"]["value"],
                    currency=invoice["amount"]["currency_code"],
                    status=invoice["status"],
                    due=invoice.get("due_amount", {}).get("value", "0.00"),
                ),
            )
        if parts[:3] == ["v2", "invoicing", "invoices"]:
            if len(parts) == 3:
                return self._list(parsed.query)
            invoice = _state["invoices"].get(parts[3])
            if not invoice:
                return self._json(
                    404,
                    {"name": "RESOURCE_NOT_FOUND", "message": "Invoice not found"},
                )
            return self._json(200, invoice)
        # Anything else is real PayPal — orders, subscriptions, token, ...
        return self._proxy("GET")

    def do_POST(self):
        # Drain the body up front, whatever the route does with it.
        length = int(self.headers.get("Content-Length") or 0)
        self._raw = self.rfile.read(length) if length else b""
        parsed = urllib.parse.urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]

        if parsed.path == "/v2/invoicing/invoices":
            return self._create()
        if parts[:3] == ["v2", "invoicing", "invoices"] and len(parts) >= 5:
            invoice_id, action = parts[3], parts[4]
            if action == "send":
                return self._send_invoice(invoice_id)
            if action == "remind":
                return self._empty(204)
            if action == "cancel":
                with _lock:
                    invoice = _state["invoices"].get(invoice_id)
                    if not invoice:
                        return self._json(404, {"name": "RESOURCE_NOT_FOUND"})
                    invoice["status"] = "CANCELLED"
                    _save()
                return self._empty(204)
            if action == "refunds":
                return self._refund(invoice_id)
        if len(parts) == 3 and parts[0] == "_mock" and parts[1] == "pay":
            return self._pay(parts[2])
        return self._proxy("POST")


if __name__ == "__main__":
    _load()
    print(f"mock-paypal: Invoicing v2 on http://localhost:{PORT}")
    print(f"  invoicing: emulated   everything else: proxied to {UPSTREAM}")
    print(f"  state: {STATE_FILE}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
