# tests/test_meterpal_billing.py
#
# Unit tests for the MeterPalBridge CustomLogger. Run with pytest.
#
# These tests do NOT need a live MeterPal or Redis. They mock httpx so the
# bridge's HTTP calls are deterministic. They verify:
#   - admission short-circuit raises 402 when balance is exhausted
#   - lock_id is plumbed through metadata when PAB_USE_LOCK=true
#   - success path settles track_tokens before committing the lock
#   - failure path settles track_tokens before releasing the lock
#   - /check is never cached (each request gets its own check and hold)
#   - billing unreachable + fail-open is refused unless require_lock=false
#   - customer_id extraction from kwargs / data / metadata
#   - no hardcoded secrets in code
#
# Run:    pytest tests/test_meterpal_billing.py -v
# Run all: pytest tests/ -v

from __future__ import annotations

import importlib
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Keep the real gateway/.env out of the test process.

    Two import-time loaders refill deleted vars otherwise: litellm's package
    __init__ calls load_dotenv() in DEV mode (finds gateway/.env from cwd),
    and the bridge's own _load_env_file_fallback.  LITELLM_MODE=PROD silences
    the first, PAB_ENV_FILE=0 the second; the sweep clears anything an
    earlier import leaked.  Tests must see exactly what they set."""
    for name in list(os.environ):
        if name.startswith(("PAB_", "AUTUMN_")):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LITELLM_MODE", "PROD")
    monkeypatch.setenv("PAB_ENV_FILE", "0")
    yield


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("PAB_API_KEY", "am_sk_test_1234567890")
    monkeypatch.setenv("PAB_BASE_URL", "https://billing.test/v1")
    monkeypatch.setenv("PAB_FEATURE_ID", "ai_tokens")
    monkeypatch.setenv("PAB_CUSTOMER_HEADER", "user")
    monkeypatch.setenv("PAB_ADMIT_MODE", "block")
    monkeypatch.setenv("PAB_TIMEOUT_SEC", "2.0")
    monkeypatch.setenv("PAB_FAIL_MODE", "open")
    monkeypatch.setenv("PAB_USE_LOCK", "true")
    return monkeypatch


@pytest.fixture
def bridge(env):
    # Reload the module to pick up env vars
    sys.modules.pop("litellm.integrations.meterpal_billing", None)
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    return mod.MeterPalBridge()


@pytest.fixture
def mock_httpx():
    """Patch the httpx.AsyncClient used by the bridge."""
    responses = []

    def make_client(*args, **kwargs):
        client = MagicMock()
        client.post = AsyncMock(side_effect=lambda path, json: _queue_response(responses, path, json))
        client.aclose = AsyncMock()
        return client

    with patch("litellm.integrations.meterpal_billing.httpx.AsyncClient", side_effect=make_client):
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
async def test_check_is_never_cached(bridge, mock_httpx):
    """Admission is never cached: two requests each get their own check and
    their own reservation.  (An earlier version cached the /check response
    for PAB_CHECK_TTL_SEC, which let N concurrent requests bill against a
    single hold -- the cache is gone for exactly that reason.)"""
    mock_httpx.append({"body": {"allowed": True, "lock": {"lock_id": "lock_x"}}})
    mock_httpx.append({"body": {"allowed": True, "lock": {"lock_id": "lock_y"}}})
    uak = MagicMock()
    uak.end_user_id = None
    data = {"user": "cus_cached"}

    r1 = await bridge.async_pre_call_hook(uak, MagicMock(), dict(data), "completion")
    r2 = await bridge.async_pre_call_hook(uak, MagicMock(), dict(data), "completion")

    assert r1["metadata"]["_autumn_lock_id"] == "lock_x"
    assert r2["metadata"]["_autumn_lock_id"] == "lock_y"
    # queue exhausted -> two HTTP calls made
    assert len(mock_httpx) == 0


@pytest.mark.asyncio
async def test_check_fail_open_when_billing_unreachable(env, mock_httpx):
    """PAB_FAIL_MODE=open with the billing server unreachable.

    An unreserved request is still an unheld charge, so with
    PAB_REQUIRE_LOCK=true (the hardened default) the request is refused even
    in fail-open mode; require_lock=false is the degradation valve that
    admits it unbilled."""
    import httpx
    from fastapi import HTTPException

    mock_httpx.append(httpx.ConnectError("connection refused"))
    mock_httpx.append(httpx.ConnectError("connection refused"))

    sys.modules.pop("litellm.integrations.meterpal_billing", None)
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    b = mod.MeterPalBridge()
    uak = MagicMock()
    uak.end_user_id = None
    data = {"user": "cus_degraded"}

    # Hardened default: no reservation -> no admission.
    with pytest.raises(HTTPException) as exc_info:
        await b.async_pre_call_hook(uak, MagicMock(), dict(data), "completion")
    assert exc_info.value.status_code == 402

    # The valve: require_lock=false serves the request degraded.
    b.require_lock = False
    result = await b.async_pre_call_hook(uak, MagicMock(), dict(data), "completion")
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
    # The charge is settled before the hold is released: releasing first put
    # the whole balance back while the charge was still pending.
    assert paths == ["/track_tokens", "/balances.finalize"]
    assert calls[1][1]["action"] == "confirm"

    track_body = calls[0][1]
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
    # Same charge-before-release ordering as the success path.
    assert paths == ["/track_tokens", "/balances.finalize"]
    assert calls[1][1]["action"] == "release"
    track_body = calls[0][1]
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
    src_path = os.path.join(os.path.dirname(__file__), "..", "litellm", "integrations", "meterpal_billing.py")
    with open(src_path, encoding="utf-8") as f:
        src = f.read()
    forbidden = ["sk-live-", "sk_live_", "whsec_live_", "pk_live_"]
    for s in forbidden:
        assert s not in src, f"Forbidden secret pattern {s!r} found in meterpal_billing.py"


@pytest.mark.asyncio
async def test_no_lock_mode_does_not_send_lock_param(bridge, mock_httpx):
    """With PAB_USE_LOCK=false, /check body must not include lock=true."""
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
    """LiteLLM sends bare aliases or deployment strings; PAB_MODEL_ID_MAP
    normalizes both to a billable "<provider>/<model>" id.  Unmapped ids pass
    through unchanged."""
    import json as _json

    env.setenv(
        "PAB_MODEL_ID_MAP",
        _json.dumps({"demo-gpt": "custom/demo-gpt", "gpt-4o-mini-mock": "openai/gpt-4o-mini"}),
    )
    sys.modules.pop("litellm.integrations.meterpal_billing", None)
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    b = mod.MeterPalBridge()

    assert b._model_id({"model": "demo-gpt"}) == "custom/demo-gpt"
    # deployment string falls back to the bare-name lookup
    assert b._model_id({"model": "openai/demo-gpt"}) == "custom/demo-gpt"
    assert b._model_id({"model": "gpt-4o-mini-mock"}) == "openai/gpt-4o-mini"
    # unmapped models are forwarded as-is
    assert b._model_id({"model": "anthropic/claude-sonnet-4-5"}) == "anthropic/claude-sonnet-4-5"
    assert b._model_id({"model": ""}) == ""


@pytest.mark.asyncio
async def test_check_sends_required_balance(env, mock_httpx):
    """The /check body carries PAB_REQUIRED_BALANCE so admission demands
    explicit headroom instead of relying on MeterPal's server-side default."""
    env.setenv("PAB_REQUIRED_BALANCE", "0.5")
    sys.modules.pop("litellm.integrations.meterpal_billing", None)
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    b = mod.MeterPalBridge()
    assert b.required_balance == 0.5

    captured = []

    def fake_post(path, json):
        captured.append((path, json))
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        # A reservation comes back, or PAB_REQUIRE_LOCK=true refuses the
        # request no matter what /check said about the balance.
        mock_resp.json = MagicMock(
            return_value={"allowed": True, "lock": {"lock_id": "lock_req"}}
        )
        return mock_resp

    b._client = MagicMock()
    b._client.post = AsyncMock(side_effect=fake_post)

    uak = MagicMock()
    uak.end_user_id = None
    await b.async_pre_call_hook(uak, MagicMock(), {"user": "cus_req"}, "completion")
    assert captured[0][0] == "/check"
    assert captured[0][1]["required_balance"] == 0.5

def test_legacy_autumn_env_fallback(monkeypatch):
    """Legacy AUTUMN_* env names still configure the bridge (PAB_* wins)."""
    monkeypatch.delenv("PAB_API_KEY", raising=False)
    monkeypatch.delenv("PAB_BASE_URL", raising=False)
    monkeypatch.setenv("AUTUMN_API_KEY", "am_sk_test_legacy")
    monkeypatch.setenv("AUTUMN_BASE_URL", "https://legacy.test/v1")
    sys.modules.pop("litellm.integrations.meterpal_billing", None)
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    b = mod.MeterPalBridge()
    assert b.api_key == "am_sk_test_legacy"
    assert b.base_url == "https://legacy.test/v1"

    # PAB_* takes precedence when both are present.
    monkeypatch.setenv("PAB_API_KEY", "am_sk_test_new")
    sys.modules.pop("litellm.integrations.meterpal_billing", None)
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    assert mod.MeterPalBridge().api_key == "am_sk_test_new"


def test_env_file_fallback_fills_missing_vars(monkeypatch, tmp_path):
    """A launcher that skipped gateway/.env gets its keys back: the bridge
    parses the file itself.  Surrounding quotes are stripped, matching every
    other loader in the repo (stack.ps1 Import-EnvFile, run_demo.load_env)."""
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# a comment line\n"
        "PAB_API_KEY=am_sk_from_file\n"
        "PAB_BASE_URL='https://quoted.test/v1'\n"
        'PAB_FEATURE_ID="ai_tokens"\n'
        "PAB_MODEL_ID_MAP='{\"demo-gpt\":\"custom/demo-gpt\"}'\n"
        "MALFORMED LINE WITHOUT EQUALS\n",
        encoding="utf-8",
    )
    # Register for teardown, then remove, so nothing leaks into other tests.
    for name in ("PAB_API_KEY", "PAB_BASE_URL", "PAB_FEATURE_ID", "PAB_MODEL_ID_MAP"):
        monkeypatch.setenv(name, "__registered_for_teardown__")
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("AUTUMN_API_KEY", raising=False)
    monkeypatch.delenv("PAB_ENV_FILE", raising=False)  # re-enable the fallback

    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    mod._load_env_file_fallback(env_file)

    assert os.environ["PAB_API_KEY"] == "am_sk_from_file"
    assert os.environ["PAB_BASE_URL"] == "https://quoted.test/v1"
    assert os.environ["PAB_FEATURE_ID"] == "ai_tokens"
    assert os.environ["PAB_MODEL_ID_MAP"] == '{"demo-gpt":"custom/demo-gpt"}'
    # A value that parses as valid JSON after quote-stripping configures the map.
    b = mod.MeterPalBridge()
    assert b.model_id_map == {"demo-gpt": "custom/demo-gpt"}


def test_env_file_fallback_never_overrides_launcher(monkeypatch, tmp_path):
    """An explicit launcher value wins; the file only fills what is missing.
    An empty launcher value counts as unset, so the file may fill it."""
    env_file = tmp_path / ".env"
    env_file.write_text(
        "PAB_API_KEY=am_sk_from_file\nPAB_BASE_URL=https://file.test/v1\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PAB_API_KEY", "am_sk_from_launcher")
    monkeypatch.setenv("PAB_BASE_URL", "")  # empty configures nothing
    monkeypatch.delenv("PAB_ENV_FILE", raising=False)  # re-enable the fallback

    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    mod._load_env_file_fallback(env_file)

    assert os.environ["PAB_API_KEY"] == "am_sk_from_launcher"
    assert os.environ["PAB_BASE_URL"] == "https://file.test/v1"


def test_env_file_fallback_missing_file_is_a_noop(monkeypatch, tmp_path):
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    # Must not raise and must not touch the environment.
    before = dict(os.environ)
    mod._load_env_file_fallback(tmp_path / "does-not-exist" / ".env")
    assert os.environ == before


def test_model_id_map_survives_shell_quoting(env):
    """A launcher that injected the raw single-quoted .env value still parses:
    one layer of surrounding quotes is stripped before json.loads (seen live
    2026-11-06: PAB_MODEL_ID_MAP passed through with its quoting intact)."""
    env.setenv("PAB_MODEL_ID_MAP", '\'{"demo-gpt":"custom/demo-gpt"}\'')
    sys.modules.pop("litellm.integrations.meterpal_billing", None)
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    b = mod.MeterPalBridge()

    assert b.model_id_map == {"demo-gpt": "custom/demo-gpt"}
    assert b._model_id({"model": "demo-gpt"}) == "custom/demo-gpt"


def test_model_id_map_garbage_stays_empty(env):
    """Genuinely invalid JSON still fails loudly and leaves the map empty."""
    env.setenv("PAB_MODEL_ID_MAP", "not-json{")
    sys.modules.pop("litellm.integrations.meterpal_billing", None)
    mod = importlib.import_module("litellm.integrations.meterpal_billing")
    b = mod.MeterPalBridge()

    assert b.model_id_map == {}
