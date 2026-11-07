"""MeterPal Python client.

Thin, typed wrapper over the MeterPal billing server REST API (the
PayPal-native fork of Autumn).  One client, one secret key, every money
movement on PayPal rails.

    from meterpal import MeterPalClient

    billing = MeterPalClient(
        secret_key="am_sk_test_...",          # from your billing server
        base_url="http://localhost:8080/v1",
    )

    # customers
    billing.get_or_create_customer("cus_123", email="user@example.com")

    # admission control (usually handled by the gateway hook, not you)
    res = billing.check("cus_123", required_balance=0.5)
    if not res["allowed"]:
        raise QuotaExceeded(res)

    # top a wallet up (the call a PayPal webhook makes automatically)
    billing.update_balance("cus_123", "ai_tokens", add_to_balance=25.0)

    # send a PayPal invoice for usage overage
    billing.create_overage_invoice("cus_123", amount_usd=12.40)

The full money loop (PayPal checkout -> webhooks -> wallet credits) is
server-side; see the repo README for the architecture.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import httpx

DEFAULT_BASE_URL = "http://localhost:8080/v1"


class MeterPalError(RuntimeError):
    """Non-2xx from the billing server.  Carries status + payload."""

    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self.payload = payload
        detail = payload if isinstance(payload, str) else (payload or {}).get("detail", payload)
        super().__init__(f"meterpal HTTP {status_code}: {detail}")


class MeterPalClient:
    def __init__(
        self,
        secret_key: str,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 15.0,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        if not secret_key:
            raise ValueError("secret_key is required")
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {secret_key}",
                "Content-Type": "application/json",
            },
            params={"am-version": "V1_2"},
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "MeterPalClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -------- internals --------

    def _request(self, method: str, path: str, json: Any = None) -> Any:
        resp = self._client.request(method, path, json=json)
        if resp.status_code >= 300:
            try:
                payload: Any = resp.json()
            except ValueError:
                payload = resp.text
            raise MeterPalError(resp.status_code, payload)
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    # -------- customers --------

    def get_or_create_customer(
        self,
        customer_id: str,
        *,
        name: Optional[str] = None,
        email: Optional[str] = None,
        fingerprint: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        expand: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Create-or-fetch a customer (get-or-create semantics)."""
        body: dict[str, Any] = {"id": customer_id}
        if name is not None:
            body["name"] = name
        if email is not None:
            body["email"] = email
        if fingerprint is not None:
            body["fingerprint"] = fingerprint
        if metadata is not None:
            body["metadata"] = metadata
        params = {"expand": expand} if expand else None
        resp = self._client.post(
            "/customers", json=body, params=params  # type: ignore[arg-type]
        )
        if resp.status_code >= 300:
            raise MeterPalError(resp.status_code, self._safe_json(resp))
        return resp.json() or {}

    def get_customer(
        self, customer_id: str, *, expand: Optional[list[str]] = None
    ) -> dict[str, Any]:
        params = {"expand": expand} if expand else None
        resp = self._client.get(f"/customers/{customer_id}", params=params)
        if resp.status_code >= 300:
            raise MeterPalError(resp.status_code, self._safe_json(resp))
        return resp.json() or {}

    def get_customer_balance(
        self, customer_id: str, feature_id: str = "ai_tokens"
    ) -> dict[str, Any]:
        """Convenience: {feature_id, remaining, max, ...} for one balance."""
        customer = self.get_customer(customer_id, expand=["balances.feature"])
        balances = customer.get("balances") or {}
        if isinstance(balances, dict):
            # API shape: {"balances": {"ai_tokens": {...}}}
            bal = balances.get(feature_id)
            if bal is not None:
                return bal
        else:
            for bal in balances:
                if (
                    isinstance(bal, dict)
                    and (bal.get("feature_id") or bal.get("feature", {}).get("id"))
                    == feature_id
                ):
                    return bal
        raise MeterPalError(
            404, {"detail": f"no balance for feature {feature_id!r} on {customer_id}"}
        )

    # -------- admission + metering (gateway-facing) --------

    def check(
        self,
        customer_id: str,
        feature_id: str = "ai_tokens",
        *,
        required_balance: float = 1.0,
        lock: bool = False,
    ) -> dict[str, Any]:
        """Pre-call admission control. `allowed: false` means refuse BEFORE the model call."""
        body: dict[str, Any] = {
            "customer_id": customer_id,
            "feature_id": feature_id,
            "required_balance": required_balance,
        }
        if lock:
            body["lock"] = True
        return self._request("POST", "/check", body)

    def track_tokens(
        self,
        customer_id: str,
        feature_id: str,
        model_id: str,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        audio_input_tokens: int = 0,
        audio_output_tokens: int = 0,
        reasoning_tokens: int = 0,
        idempotency_key: str,
        timestamp_ms: Optional[int] = None,
        properties: Optional[dict[str, Any]] = None,
    ) -> Any:
        """Meter a completed AI call.  Idempotent on `idempotency_key` — safe to retry."""
        body: dict[str, Any] = {
            "customer_id": customer_id,
            "feature_id": feature_id,
            "model_id": model_id,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read_tokens,
            "cache_write_tokens": cache_write_tokens,
            "audio_input_tokens": audio_input_tokens,
            "audio_output_tokens": audio_output_tokens,
            "reasoning_tokens": reasoning_tokens,
            "idempotency_key": idempotency_key,
            "timestamp": timestamp_ms if timestamp_ms is not None else int(time.time() * 1000),
        }
        if properties:
            body["properties"] = properties
        return self._request("POST", "/track_tokens", body)

    def finalize_lock(
        self, customer_id: str, lock_id: str, action: str, feature_id: str = "ai_tokens"
    ) -> Any:
        """Commit ('commit') or release ('release') a reservation taken via check(lock=True)."""
        return self._request(
            "POST",
            "/balances.finalize",
            {
                "customer_id": customer_id,
                "lock_id": lock_id,
                "action": action,
                "feature_id": feature_id,
            },
        )

    # -------- balances (wallet) --------

    def update_balance(
        self,
        customer_id: str,
        feature_id: str,
        *,
        add_to_balance: Optional[float] = None,
        remaining: Optional[float] = None,
    ) -> Any:
        """Grant credits (`add_to_balance`) or set an absolute `remaining`.

        In production this is what the PayPal webhook path calls when
        PAYMENT.CAPTURE.COMPLETED / PAYMENT.SALE.COMPLETED / INVOICING.INVOICE.PAID
        lands.  You rarely call it by hand outside tests and seeding.
        """
        body: dict[str, Any] = {"customer_id": customer_id, "feature_id": feature_id}
        if add_to_balance is not None:
            body["add_to_balance"] = add_to_balance
        if remaining is not None:
            body["remaining"] = remaining
        return self._request("POST", "/balances/update", body)

    def create_balance(
        self,
        customer_id: str,
        feature_id: str,
        *,
        included_grant: Optional[float] = None,
        unlimited: bool = False,
    ) -> Any:
        body: dict[str, Any] = {"customer_id": customer_id, "feature_id": feature_id}
        if included_grant is not None:
            body["included_grant"] = included_grant
        if unlimited:
            body["unlimited"] = True
        return self._request("POST", "/balances/create", body)

    # -------- catalog (merchant setup) --------

    def create_feature(
        self,
        feature_id: str,
        name: str,
        *,
        type_: str = "credit_system",
        **extra: Any,
    ) -> Any:
        body: dict[str, Any] = {"id": feature_id, "name": name, "type": type_, **extra}
        return self._request("POST", "/features", body)

    def create_plan(
        self,
        plan_id: str,
        name: str,
        *,
        items: Optional[list[dict[str, Any]]] = None,
        **extra: Any,
    ) -> Any:
        """Create a plan/product.  `items` carries prices + entitlement grants.

        The server skips processor catalog creation when no PayPal credentials are
        configured, so plans work PayPal-only out of the box.
        """
        body: dict[str, Any] = {"id": plan_id, "name": name, **extra}
        if items is not None:
            body["items"] = items
        return self._request("POST", "/plans", body)

    # -------- PayPal checkout + invoicing --------

    def checkout(
        self,
        customer_id: str,
        product_id: str,
        *,
        success_url: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create a PayPal checkout (Orders v2 for credit packs, Subscriptions
        for plans).  Returns `{url, ...}` — send the buyer to `url` to approve,
        then PayPal webhooks credit the wallet.
        """
        body: dict[str, Any] = {
            "customer_id": customer_id,
            "product_id": product_id,
        }
        if success_url:
            body["success_url"] = success_url
        result = self._request("POST", "/checkout", body)
        return result or {}

    def create_overage_invoice(
        self,
        customer_id: str,
        amount_usd: float,
        *,
        item_name: str = "AI usage overage",
        note: Optional[str] = None,
        memo: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create + send a PayPal invoice for usage overage.  When the buyer
        pays it, the INVOICING.INVOICE.PAID webhook credits the wallet."""
        body: dict[str, Any] = {
            "customer_id": customer_id,
            "amount_usd": amount_usd,
            "item_name": item_name,
        }
        if note:
            body["note"] = note
        if memo:
            body["memo"] = memo
        return self._request("POST", "/overage_invoices", body)

    @staticmethod
    def _safe_json(resp: httpx.Response) -> Any:
        try:
            return resp.json()
        except ValueError:
            return resp.text
