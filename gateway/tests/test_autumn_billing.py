# tests/test_autumn_billing.py
#
# Unit tests for the AutumnBillingBridge CustomLogger. Run with pytest.
#
# These tests do NOT need a live Autumn or Redis. They mock httpx so the
# bridge's HTTP calls are deterministic. They verify:
#   - admission short-circuit raises 402 when balance is exhausted
#   - lock_id is plumbed through metadata when AUTUMN_USE_LOCK=true
#   - success path commits the lock and calls track_tokens with the right shape
#   - failure path releases the lock and calls track_tokens with status=failure
#   - /check short-circuit cache works
#   - customer_id extraction from kwargs / data / metadata
#   - no hardcoded secrets in code
#
# Run:    pytest tests/test_autumn_billing.py -v
# Run all: pytest tests/ -v

from __future__ import annotations

import importlib
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("AUTUMN_API_KEY", "am_sk_test_1234567890")
    monkeypatch.setenv("AUTUMN_BASE_URL", "https://autumn.test/v1")
    monkeypatch.setenv("AUTUMN_FEATURE_ID", "ai_tokens")
    monkeypatch.setenv("AUTUMN_CUSTOMER_HEADER", "user")
    monkeypatch.setenv("AUTUMN_ADMIT_MODE", "block")
    monkeypatch.setenv("AUTUMN_TIMEOUT_SEC", "2.0")
    monkeypatch.setenv("AUTUMN_FAIL_MODE", "open")
    monkeypatch.setenv("AUTUMN_USE_LOCK", "true")
    return monkeypatch


@pytest.fixture
def bridge(env):
    # Reload the module to pick up env vars
    sys.modules.pop("litellm.integrations.autumn_billing", None)
    mod = importlib.import_module("litellm.integrations.autumn_billing")
    return mod.AutumnBillingBridge()


@pytest.fixture
def mock_httpx():
    """Patch the httpx.AsyncClient used by the bridge."""
    responses = []

    def make_client(*args, **kwargs):
        client = MagicMock()
        client.post = AsyncMock(side_effect=lambda path, json: _queue_response(responses, path, json))
        client.aclose = AsyncMock()
        return client

    with patch("litellm.integrations.autumn_billing.httpx.AsyncClient", side_effect=make_client):
        yield responses


def _queue_response(responses, path, json):
    if not responses:
        raise RuntimeError(f"unexpected HTTP call to {path}")
    r = responses.pop(0)
    if isinstance(r, Exception):
        raise r

    mock_resp = MagicMock()
    mock_resp.status_code = r.get("status", 200)
    mock_resp.raise_for_status = MagicMock(side_effect=lambda: None if mock_resp.status_code < 400 else Exception(f"{mock_resp.status_code}"))
    mock_resp.json = MagicMock(return_value=r.get("body", {}))
    return mock_resp


@pytest.mark.asyncio
async def test_admission_allowed_returns_data_with_lock(bridge, mock_httpx):
    mock_httpx.append({"body": {"allowed": True, "lock": {"lock_id": "lock_abc"}}})

    uak = MagicMock()
    uak.end_user_id = None
    data = {"user": "cus_123", "model": "claude-sonnet-4-5"}

    result = await bridge.async_pre_call_hook(uak, MagicMock(), data, "completion")
    assert result["user"] == "cus_123"
    assert result["metadata"]["_autumn_lock_id"] == "lock_abc"
    assert result["metadata"]["_autumn_customer_id"] == "cus_123"


@pytest.mark.asyncio
async def test_admission_blocked_raises_402(bridge, mock_httpx):
    mock_httpx.append({"body": {"allowed": False}})

    uak = MagicMock()
    uak.end_user_id = None
    data = {"user": "cus_123"}

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as excinfo:
        await bridge.async_pre_call_hook(uak, MagicMock(), data, "completion")
    assert excinfo.value.status_code == 402
    assert excinfo.value.detail["error"] == "insufficient_balance"


@pytest.mark.asyncio
async def test_check_short_circuit_cache(bridge, mock_httpx):
    """Two calls in quick succession should produce only one HTTP call."""
    mock_httpx.append({"body": {"allowed": True, "lock": {"lock_id": "lock_x"}}})
    uak = MagicMock()
    uak.end_user_id = None
    data = {"user": "cus_cached"}

    r1 = await bridge.async_pre_call_hook(uak, MagicMock(), dict(data), "completion")
    r2 = await bridge.async_pre_call_hook(uak, MagicMock(), dict(data), "completion")

    assert r1["metadata"]["_autumn_lock_id"] == "lock_x"
    assert r2["metadata"]["_autumn_lock_id"] == "lock_x"
    # queue exhausted -> only one HTTP call made
    assert len(mock_httpx) == 0


@pytest.mark.asyncio
async def test_check_fail_open_when_autumn_unreachable(env, mock_httpx):
    """When AUTUMN_FAIL_MODE=open and /check raises, admission should still succeed."""
    import httpx
    mock_httpx.append(httpx.ConnectError("connection refused"))

    sys.modules.pop("litellm.integrations.autumn_billing", None)
    mod = importlib.import_module("litellm.integrations.autumn_billing")
    b = mod.AutumnBillingBridge()
    uak = MagicMock()
    uak.end_user_id = None
    data = {"user": "cus_degraded"}

    # Should not raise
    result = await b.async_pre_call_hook(uak, MagicMock(), data, "completion")
    assert result["user"] == "cus_degraded"


def _capturing_client(calls: list):
    """Client whose POSTs are recorded as (path, json) tuples and answer 200."""

    def fake_post(path, json):
        calls.append((path, json))
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json = MagicMock(return_value={"id": "evt_ok"})
        return mock_resp

    client = MagicMock()
    client.post = AsyncMock(side_effect=fake_post)
    client.aclose = AsyncMock()
    return client


@pytest.mark.asyncio
async def test_success_commits_lock_and_calls_track(bridge):
    """Real LiteLLM logging-payload shape: usage under kwargs["usage"] and
    the customer id carried through litellm metadata."""
    calls: list = []
    bridge._client = _capturing_client(calls)

    kwargs = {
        "model": "anthropic/claude-sonnet-4-5",
        "response_cost": 0.0025,
        "litellm_call_id": "req-uuid-1",
        "usage": SimpleNamespace(
            prompt_tokens=150,
            completion_tokens=50,
            cache_read_input_tokens=50,
        ),
        "litellm_params": {
            "metadata": {"_autumn_lock_id": "lock_abc", "_autumn_customer_id": "cus_123"}
        },
    }

    await bridge.async_log_success_event(kwargs, None, None, None)

    paths = [c[0] for c in calls]
    assert paths == ["/balances.finalize", "/track_tokens"]
    assert calls[0][1]["action"] == "commit"

    track_body = calls[1][1]
    assert track_body["customer_id"] == "cus_123"
    # prompt_tokens includes cached input: non-cached input = 150 - 50.
    assert track_body["input_tokens"] == 100
    assert track_body["output_tokens"] == 50
    assert track_body["cache_read_tokens"] == 50
    assert track_body["idempotency_key"] == "req-uuid-1"
    assert track_body["properties"]["status"] == "success"
    assert track_body["properties"]["model_id"] == "anthropic/claude-sonnet-4-5"
    assert isinstance(track_body["timestamp"], int)  # unix ms, not ISO string


@pytest.mark.asyncio
async def test_failure_releases_lock_and_records_failure(bridge):
    calls: list = []
    bridge._client = _capturing_client(calls)

    kwargs = {
        "model": "openai/gpt-4o",
        "response_cost": 0.0,
        "litellm_call_id": "req-uuid-2",
        "usage": {"prompt_tokens": 10, "completion_tokens": 0},
        "litellm_params": {"metadata": {"_autumn_lock_id": "lock_xyz", "_autumn_customer_id": "cus_456"}},
        "exception": RuntimeError("upstream timeout"),
    }

    await bridge.async_log_failure_event(kwargs, None, None, None)

    paths = [c[0] for c in calls]
    assert paths == ["/balances.finalize", "/track_tokens"]
    assert calls[0][1]["action"] == "release"
    track_body = calls[1][1]
    assert track_body["customer_id"] == "cus_456"
    assert track_body["properties"]["status"] == "failure"
    assert track_body["properties"]["error_type"] == "RuntimeError"


@pytest.mark.asyncio
async def test_success_reads_usage_from_response_obj(bridge):
    """Real LiteLLM shape discovered live: kwargs["usage"] is None and the
    tokens live on response_obj.usage (the ModelResponse's Usage object)."""
    calls: list = []
    bridge._client = _capturing_client(calls)
    bridge.use_lock = False

    kwargs = {
        "model": "openai/gpt-4o-mini",
        "response_cost": 0.0012,
        "litellm_call_id": "req-uuid-3",
        "usage": None,
        "litellm_params": {"metadata": {"_autumn_customer_id": "cus_789"}},
    }
    response_obj = SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=1200,
            completion_tokens=300,
            prompt_tokens_details=SimpleNamespace(cached_tokens=800),
            completion_tokens_details=SimpleNamespace(reasoning_tokens=0),
        )
    )

    await bridge.async_log_success_event(kwargs, response_obj, None, None)

    track_body = calls[0][1]
    assert track_body["customer_id"] == "cus_789"
    # prompt_tokens includes cached input: non-cached input = 1200 - 800.
    assert track_body["input_tokens"] == 400
    assert track_body["output_tokens"] == 300
    assert track_body["cache_read_tokens"] == 800
    assert track_body["properties"]["status"] == "success"


@pytest.mark.asyncio
async def test_success_reads_legacy_top_level_tokens(bridge, mock_httpx):
    """Legacy fallback: kwargs that carry tokens at the top level still bill."""
    mock_httpx.append({"body": {"success": True}})  # finalize/commit
    mock_httpx.append({"body": {"id": "evt_1", "balance": {"remaining": 999}}})  # track_tokens

    kwargs = {
        "user_api_key_end_user_id": "cus_123",
        "model": "anthropic/claude-sonnet-4-5",
        "prompt_tokens": 100,
        "completion_tokens": 50,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "reasoning_tokens": 0,
        "response_cost": 0.0025,
        "litellm_call_id": "req-uuid-1",
        "litellm_params": {"metadata": {"_autumn_lock_id": "lock_abc", "_autumn_customer_id": "cus_123"}},
    }

    await bridge.async_log_success_event(kwargs, None, None, None)
    assert len(mock_httpx) == 0  # both queued requests consumed


@pytest.mark.asyncio
async def test_post_call_customer_id_resolution(bridge):
    """Metadata-carryover wins, then top-level end-user id."""
    assert (
        bridge._post_call_customer_id(
            {"litellm_params": {"metadata": {"_autumn_customer_id": "cus_meta"}}}
        )
        == "cus_meta"
    )
    assert bridge._post_call_customer_id({"user_api_key_end_user_id": "cus_top"}) == "cus_top"
    assert bridge._post_call_customer_id({}) is None


@pytest.mark.asyncio
async def test_customer_id_extraction_precedence(bridge, mock_httpx):
    """customer_id comes from data[header] first, then data[user], then uak.end_user_id."""
    cases = [
        ({"user": "from_user"}, MagicMock(end_user_id="from_uak"), "from_user"),
        ({"user": "from_user", "custom_header": "from_header"}, MagicMock(end_user_id="from_uak"), "from_user"),
        ({"end_user_id": "from_eu"}, MagicMock(end_user_id="from_uak"), "from_eu"),
        ({}, MagicMock(end_user_id="from_uak"), "from_uak"),
        ({}, MagicMock(end_user_id=None), None),
    ]
    for data, uak, expected in cases:
        assert bridge._customer_id(data, uak) == expected or (expected is None and bridge._customer_id(data, uak) is None)


def test_no_secrets_in_source():
    """Static guard against accidental secret commits."""
    src_path = os.path.join(os.path.dirname(__file__), "..", "litellm", "integrations", "autumn_billing.py")
    with open(src_path, encoding="utf-8") as f:
        src = f.read()
    forbidden = ["sk-live-", "sk_live_", "whsec_live_", "pk_live_"]
    for s in forbidden:
        assert s not in src, f"Forbidden secret pattern {s!r} found in autumn_billing.py"


@pytest.mark.asyncio
async def test_no_lock_mode_does_not_send_lock_param(bridge, mock_httpx):
    """With AUTUMN_USE_LOCK=false, /check body must not include lock=true."""
    bridge.use_lock = False
    mock_httpx.append({"body": {"allowed": True}})

    captured = []

    def fake_post(path, json):
        captured.append((path, json))
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"allowed": True})
        return mock_resp

    bridge._client = MagicMock()
    bridge._client.post = AsyncMock(side_effect=fake_post)

    uak = MagicMock()
    uak.end_user_id = None
    data = {"user": "cus_no_lock"}

    await bridge.async_pre_call_hook(uak, MagicMock(), data, "completion")
    assert captured[0][1].get("lock") is None


def test_model_id_map_normalizes_aliases(env):
    """LiteLLM sends bare aliases or deployment strings; AUTUMN_MODEL_ID_MAP
    normalizes both to a billable "<provider>/<model>" id.  Unmapped ids pass
    through unchanged."""
    import json as _json

    env.setenv(
        "AUTUMN_MODEL_ID_MAP",
        _json.dumps({"demo-gpt": "custom/demo-gpt", "gpt-4o-mini-mock": "openai/gpt-4o-mini"}),
    )
    sys.modules.pop("litellm.integrations.autumn_billing", None)
    mod = importlib.import_module("litellm.integrations.autumn_billing")
    b = mod.AutumnBillingBridge()

    assert b._model_id({"model": "demo-gpt"}) == "custom/demo-gpt"
    # deployment string falls back to the bare-name lookup
    assert b._model_id({"model": "openai/demo-gpt"}) == "custom/demo-gpt"
    assert b._model_id({"model": "gpt-4o-mini-mock"}) == "openai/gpt-4o-mini"
    # unmapped models are forwarded as-is
    assert b._model_id({"model": "anthropic/claude-sonnet-4-5"}) == "anthropic/claude-sonnet-4-5"
    assert b._model_id({"model": ""}) == ""


@pytest.mark.asyncio
async def test_check_sends_required_balance(env, mock_httpx):
    """The /check body carries AUTUMN_REQUIRED_BALANCE so admission demands
    explicit headroom instead of relying on Autumn's server-side default."""
    env.setenv("AUTUMN_REQUIRED_BALANCE", "0.5")
    sys.modules.pop("litellm.integrations.autumn_billing", None)
    mod = importlib.import_module("litellm.integrations.autumn_billing")
    b = mod.AutumnBillingBridge()
    assert b.required_balance == 0.5

    captured = []

    def fake_post(path, json):
        captured.append((path, json))
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"allowed": True})
        return mock_resp

    b._client = MagicMock()
    b._client.post = AsyncMock(side_effect=fake_post)

    uak = MagicMock()
    uak.end_user_id = None
    await b.async_pre_call_hook(uak, MagicMock(), {"user": "cus_req"}, "completion")
    assert captured[0][0] == "/check"
    assert captured[0][1]["required_balance"] == 0.5