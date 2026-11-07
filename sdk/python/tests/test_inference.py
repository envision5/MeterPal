"""Unit tests for the MeterPal inference client (httpx MockTransport, no server).

Mirrors sdk/typescript/src/inference/client.test.ts: the contract the TS
drop-in proves out is the contract the Python drop-in must keep.
"""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx
import pytest

from meterpal import (
    DEFAULT_API_BASE_URL,
    APIError,
    InsufficientBalanceError,
    MeterPalInferenceError,
    ModelNotEnabledError,
    ModelNotFoundError,
    create_meterpal,
)
from meterpal import inference as inference_module


@pytest.fixture(autouse=True)
def fresh_virtual_key_cache():
    """One test's minted keys must not satisfy another test's resolution."""
    inference_module._virtual_key_cache.clear()
    yield
    inference_module._virtual_key_cache.clear()


OPENAI_BODY = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}}],
    "meterpal": {
        "credits_charged": 0.04,
        "balance_after": 2.96,
        "customer_id": "cus_123",
        "model_id": "custom/demo-gpt",
        "input_tokens": 100,
        "output_tokens": 20,
    },
}


def make_client(handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any):
    return create_meterpal(
        api_key=kwargs.pop("api_key", "am_sk_test_123"),
        base_url=kwargs.pop("base_url", "http://billing.test"),
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def test_create_bills_the_end_user_and_returns_the_meterpal_block():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("Authorization"), request.content))
        if request.url.path == "/v1/keys":
            return httpx.Response(200, json={"key": "sk-virtual-1", "customer_id": "cus_123", "created": True})
        return httpx.Response(200, json=OPENAI_BODY)

    with make_client(handler) as meterpal:
        completion = meterpal.chat.completions.create(
            model="custom/demo-gpt",
            messages=[{"role": "user", "content": "hi"}],
            user="cus_123",
        )

    assert completion["meterpal"]["credits_charged"] == 0.04
    paths = [s[0] for s in seen]
    assert paths == ["/v1/keys", "/v1/chat/completions"]
    # the secret key mints the key; the call carries the per-customer virtual key
    assert seen[0][1] == "Bearer am_sk_test_123"
    assert seen[1][1] == "Bearer sk-virtual-1"
    body = json.loads(seen[1][2])
    assert body["user"] == "cus_123"


def test_virtual_key_is_cached_per_customer():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/v1/keys":
            return httpx.Response(200, json={"key": "sk-virtual-1", "customer_id": "cus_123", "created": True})
        return httpx.Response(200, json=OPENAI_BODY)

    with make_client(handler) as meterpal:
        for _ in range(2):
            meterpal.chat.completions.create(model="m", messages=[], user="cus_123")

    assert calls.count("/v1/keys") == 1
    assert calls.count("/v1/chat/completions") == 2


def test_virtual_key_passthrough_skips_provisioning():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("Authorization")))
        return httpx.Response(200, json=OPENAI_BODY)

    with make_client(handler, api_key="sk-virtual-9") as meterpal:
        meterpal.chat.completions.create(model="m", messages=[], user="cus_123")

    assert seen == [("/v1/chat/completions", "Bearer sk-virtual-9")]


def test_user_is_required():
    with make_client(lambda request: httpx.Response(200, json=OPENAI_BODY)) as meterpal:
        with pytest.raises(MeterPalInferenceError, match="user.*required"):
            meterpal.chat.completions.create(model="m", messages=[])


def test_402_becomes_the_paywall_with_a_top_up():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/keys":
            return httpx.Response(200, json={"key": "sk-virtual-1", "customer_id": "cus_123", "created": True})
        if request.url.path == "/v1/chat/completions":
            return httpx.Response(
                402,
                json={
                    "error": {
                        "type": "insufficient_balance",
                        "customer_id": "cus_123",
                        "balance": 0.02,
                        "required_credits": 0.5,
                    }
                },
            )
        if request.url.path == "/v1/checkout":
            return httpx.Response(200, json={"paymentUrl": "https://paypal.test/checkout", "id": "chk_1"})
        raise AssertionError(request.url.path)

    with make_client(handler) as meterpal:
        with pytest.raises(InsufficientBalanceError) as exc_info:
            meterpal.chat.completions.create(model="m", messages=[], user="cus_123")

        error = exc_info.value
        assert error.customer_id == "cus_123"
        assert error.balance == 0.02
        assert error.required_credits == 0.5

        top_up = error.top_up()
        assert top_up == {"url": "https://paypal.test/checkout", "id": "chk_1"}


def test_unknown_customer_is_created_and_the_call_retries():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path, json.loads(request.content) if request.content else None))
        if request.url.path == "/v1/keys":
            if [c[0] for c in calls].count("/v1/keys") == 1:
                return httpx.Response(404, json={"error": {"code": "customer_not_found"}})
            return httpx.Response(200, json={"key": "sk-virtual-1", "customer_id": "cus_new", "created": True})
        if request.url.path == "/v1/customers":
            return httpx.Response(200, json={"id": "cus_new"})
        return httpx.Response(200, json=OPENAI_BODY)

    with make_client(handler) as meterpal:
        completion = meterpal.chat.completions.create(model="m", messages=[], user="cus_new")

    paths = [c[0] for c in calls]
    assert paths == ["/v1/keys", "/v1/customers", "/v1/keys", "/v1/chat/completions"]
    # the get-or-create contract keys the body on `id`
    create_body = calls[1][1]
    assert create_body == {"id": "cus_new"}
    assert completion["meterpal"]["customer_id"] == "cus_123"


def test_model_not_enabled_maps_to_typed_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/keys":
            return httpx.Response(200, json={"key": "sk-virtual-1", "customer_id": "cus_123", "created": True})
        return httpx.Response(403, json={"error": {"code": "model_not_enabled", "message": "not served"}})

    with make_client(handler) as meterpal:
        with pytest.raises(ModelNotEnabledError):
            meterpal.chat.completions.create(model="m", messages=[], user="cus_123")


def test_unknown_model_maps_to_typed_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/keys":
            return httpx.Response(200, json={"key": "sk-virtual-1", "customer_id": "cus_123", "created": True})
        return httpx.Response(404, json={"error": {"code": "model_not_found", "message": "no such model"}})

    with make_client(handler) as meterpal:
        with pytest.raises(ModelNotFoundError):
            meterpal.chat.completions.create(model="m", messages=[], user="cus_123")


def test_stream_yields_chunks_and_the_final_charge_block():
    sse_body = (
        'data: {"choices": [{"delta": {"content": "he"}}]}\n\n'
        'data: {"choices": [{"delta": {"content": "llo"}}]}\n\n'
        'data: {"meterpal": {"credits_charged": 0.04, "balance_after": 2.96}}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/keys":
            return httpx.Response(200, json={"key": "sk-virtual-1", "customer_id": "cus_123", "created": True})
        assert request.headers.get("Accept") == "text/event-stream"
        body = json.loads(request.content)
        assert body["stream"] is True
        return httpx.Response(
            200,
            content=sse_body.encode(),
            headers={"Content-Type": "text/event-stream"},
        )

    with make_client(handler) as meterpal:
        chunks = list(
            meterpal.chat.completions.stream(model="m", messages=[], user="cus_123")
        )

    assert chunks[0]["choices"][0]["delta"]["content"] == "he"
    assert chunks[-1]["meterpal"]["credits_charged"] == 0.04


def test_stream_paywall_raises_insufficient_balance():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/keys":
            return httpx.Response(200, json={"key": "sk-virtual-1", "customer_id": "cus_123", "created": True})
        return httpx.Response(
            402,
            json={
                "error": {
                    "type": "insufficient_balance",
                    "customer_id": "cus_123",
                    "balance": 0.0,
                    "required_credits": 0.5,
                }
            },
        )

    with make_client(handler) as meterpal:
        with pytest.raises(InsufficientBalanceError) as exc_info:
            list(meterpal.chat.completions.stream(model="m", messages=[], user="cus_123"))

    assert exc_info.value.required_credits == 0.5


def test_models_list_hits_the_catalog():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/catalog"
        assert request.headers.get("Authorization") == "Bearer am_sk_test_123"
        return httpx.Response(200, json={"models": [{"id": "custom/demo-gpt"}]})

    with make_client(handler) as meterpal:
        catalog = meterpal.models.list()

    assert catalog["models"][0]["id"] == "custom/demo-gpt"


def test_keys_provision_caches_the_key():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"key": "sk-virtual-7", "customer_id": "cus_123", "created": False})

    with make_client(handler) as meterpal:
        result = meterpal.keys.provision("cus_123")

    assert result["key"] == "sk-virtual-7"
    assert inference_module._virtual_key_cache[
        inference_module._cache_key("http://billing.test", "am_sk_test_123", "cus_123")
    ] == "sk-virtual-7"


def test_unreachable_api_raises_connection_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with make_client(handler) as meterpal:
        with pytest.raises(Exception) as exc_info:  # noqa: B017
            meterpal.chat.completions.create(model="m", messages=[], user="cus_123")

    from meterpal import ConnectionError as MeterPalConnectionError

    assert isinstance(exc_info.value, MeterPalConnectionError)


def test_default_base_url_is_the_hosted_api():
    assert DEFAULT_API_BASE_URL == "https://api.meterpal.dev"


def test_api_error_when_the_answer_is_unusable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    with make_client(handler) as meterpal:
        with pytest.raises(Exception) as exc_info:  # noqa: B017
            meterpal.chat.completions.create(model="m", messages=[], user="cus_123")

    assert isinstance(exc_info.value, APIError)
    assert exc_info.value.status == 500
