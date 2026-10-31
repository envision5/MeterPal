"""Unit tests for the MeterPal Python client (httpx MockTransport, no server)."""

from __future__ import annotations

import json

import httpx
import pytest

from meterpal import MeterPalClient, MeterPalError


def make_client(handler) -> MeterPalClient:
    return MeterPalClient(
        secret_key="am_sk_test_123",
        transport=httpx.MockTransport(handler),
    )


def test_get_or_create_customer_sends_body_and_auth():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        seen["path"] = request.url.path
        seen["query"] = str(request.url.params)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "cus_1", "email": "a@b.c"})

    with make_client(handler) as client:
        customer = client.get_or_create_customer(
            "cus_1", email="a@b.c", name="Demo", expand=["balances.feature"]
        )

    assert customer["id"] == "cus_1"
    assert seen["auth"] == "Bearer am_sk_test_123"
    assert seen["path"] == "/v1/customers"
    assert "am-version=V1_2" in seen["query"]
    assert seen["body"] == {"id": "cus_1", "name": "Demo", "email": "a@b.c"}


def test_check_returns_allowed_flag_and_body_shape():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"allowed": False, "balance": 0.2})

    with make_client(handler) as client:
        res = client.check("cus_1", required_balance=0.5, lock=True)

    assert res["allowed"] is False
    assert seen["path"] == "/v1/check"
    assert seen["body"]["required_balance"] == 0.5
    assert seen["body"]["lock"] is True


def test_track_tokens_is_idempotency_keyed():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"balance": 1.5})

    with make_client(handler) as client:
        client.track_tokens(
            "cus_1",
            "ai_tokens",
            "custom/demo-gpt",
            input_tokens=100,
            output_tokens=40,
            idempotency_key="call-abc",
            properties={"cost_usd": 0.01},
        )

    body = seen["body"]
    assert seen["path"] == "/v1/track_tokens"
    assert body["idempotency_key"] == "call-abc"
    assert body["input_tokens"] == 100
    assert body["properties"]["cost_usd"] == 0.01
    assert isinstance(body["timestamp"], int)


def test_update_balance_add_to_balance():
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content) == {
            "customer_id": "cus_1",
            "feature_id": "ai_tokens",
            "add_to_balance": 25.0,
        }
        return httpx.Response(200, json={"balance": 25.0})

    with make_client(handler) as client:
        client.update_balance("cus_1", "ai_tokens", add_to_balance=25.0)


def test_checkout_posts_product_id():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/checkout"
        assert json.loads(request.content) == {
            "customer_id": "cus_1",
            "product_id": "topup_1k",
            "success_url": "https://app.example/return",
        }
        return httpx.Response(200, json={"url": "https://paypal.approve/1"})

    with make_client(handler) as client:
        res = client.checkout(
            "cus_1", "topup_1k", success_url="https://app.example/return"
        )
    assert res["url"].startswith("https://paypal.approve")


def test_overage_invoice_posts_amount():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/overage_invoices"
        assert json.loads(request.content)["amount_usd"] == 12.4
        return httpx.Response(200, json={"invoice_id": "INV2-1", "status": "SENT"})

    with make_client(handler) as client:
        res = client.create_overage_invoice("cus_1", 12.4)
    assert res["invoice_id"] == "INV2-1"


def test_error_raises_meterpal_error_with_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "Customer cus_x not found"})

    with make_client(handler) as client:
        with pytest.raises(MeterPalError) as excinfo:
            client.get_customer("cus_x")
    assert excinfo.value.status_code == 404
    assert "not found" in str(excinfo.value)


def test_get_customer_balance_finds_matching_feature():
    payload = {
        "id": "cus_1",
        "balances": [
            {"feature_id": "other", "remaining": 9},
            {"feature_id": "ai_tokens", "remaining": 1.25, "max": 2.0},
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        bal = client.get_customer_balance("cus_1")
    assert bal["remaining"] == 1.25


def test_missing_secret_key_rejected():
    with pytest.raises(ValueError):
        MeterPalClient(secret_key="")
