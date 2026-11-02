"""
litellm/integrations/meterpal_billing.py

MeterPal usage-billing bridge between the LiteLLM proxy and the MeterPal
billing server (a PayPal-native fork of Autumn).  Mirrors
litellm/proxy/hooks/proxy_track_cost_callback.py.

Responsibilities:
  1. async_pre_call_hook     -> billing POST /check  (admission; lock=true if PAB_USE_LOCK)
  2. async_log_success_event -> billing POST /balances.finalize (commit) + /track_tokens (per-token debit)
  3. async_log_failure_event -> billing POST /balances.finalize (release) + /track_tokens (failure record)

Usage tokens are read from response_obj.usage (a litellm Usage object) --
kwargs["usage"] is usually None in current LiteLLM.  The customer id
is carried from the pre-call hook through litellm metadata
("_autumn_customer_id" -- the metadata key is a cross-service contract with
the billing server's virtual-key provisioning, which stamps the same key on
generated keys) because top-level end-user fields are also absent post-call.

Security:
  - All credentials read from environment, never logged.
  - Idempotency: every track_tokens call uses kwargs['litellm_call_id'] (UUID).
  - Fail-open by default (configurable); logged.
  - Admission short-circuit raises HTTPException(402) before any provider call.

Configuration (env).  PAB_* names are primary; legacy AUTUMN_* names are
honored as fallbacks so pre-existing deployments keep working:
  PAB_BASE_URL           default https://api.meterpal.dev/v1
  PAB_API_KEY            required -- bearer token (am_sk_...)
  PAB_FEATURE_ID         default ai_tokens
  PAB_CUSTOMER_HEADER    default user
  PAB_ADMIT_MODE         block | soft
  PAB_CHECK_TTL_SEC      default 1.0
  PAB_TIMEOUT_SEC        default 2.0
  PAB_FAIL_MODE          open | closed
  PAB_USE_LOCK           true | false
  PAB_REQUIRED_BALANCE   minimum balance /check demands (default 1.0 --
                         the billing server's own default; a call may start
                         only when the customer holds at least this much)
  PAB_MODEL_ID_MAP       JSON dict mapping LiteLLM model names/aliases to
                         billable model ids.  The billing server prices models
                         by exact "<provider>/<model>" lookup against models.dev
                         (or "custom/<name>" against the feature's
                         model_markups), while LiteLLM hands the hook either
                         a bare alias or a deployment string like
                         "openai/demo-gpt".  Map one to the other, e.g.:
                           {"demo-gpt": "custom/demo-gpt"}
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional, Tuple

import httpx
from fastapi import HTTPException

from litellm.integrations.custom_logger import CustomLogger

if TYPE_CHECKING:
    # Imported only for type hints; not required at runtime.
    from litellm.proxy.proxy_server import DualCache, UserAPIKeyAuth

_LEGACY_PREFIX = "AUTUMN_"
_PREFIX = "PAB_"


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    """Read PAB_<name>, falling back to legacy AUTUMN_<name>."""
    val = os.environ.get(_PREFIX + name) or os.environ.get(_LEGACY_PREFIX + name)
    return val if val else default


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pick_int(obj: Any, *paths: str) -> int:
    """Read an int from a Usage object/dict following dotted fallback paths."""
    if obj is None:
        return 0
    for path in paths:
        cur: Any = obj
        for part in path.split("."):
            if cur is None:
                break
            if isinstance(cur, dict):
                cur = cur.get(part)
            else:
                cur = getattr(cur, part, None)
        if cur:
            return int(cur)
    return 0


def _usage_breakdown(kwargs: dict, response_obj: Any = None) -> dict:
    """Token breakdown from the LiteLLM logging payload.

    In current LiteLLM the success hook carries tokens on response_obj.usage
    (a Usage object); kwargs["usage"] is usually None.  Failure hooks get
    response_obj=None, so kwargs["usage"] and legacy top-level keys cover
    calls that failed after a partial response.  LiteLLM's prompt_tokens
    already includes cached input (for Anthropic it sums input + cache_read
    + cache_creation), so the non-cached input tokens are the remainder.
    """
    usage = kwargs.get("usage") or getattr(response_obj, "usage", None)

    def legacy(key: str) -> int:
        return int(kwargs.get(key) or 0)

    cache_read = _pick_int(usage, "cache_read_input_tokens", "prompt_tokens_details.cached_tokens") or legacy("cache_read_input_tokens")
    cache_write = _pick_int(usage, "cache_creation_input_tokens") or legacy("cache_creation_input_tokens")
    prompt_total = _pick_int(usage, "prompt_tokens") or legacy("prompt_tokens")
    completion = _pick_int(usage, "completion_tokens") or legacy("completion_tokens")
    reasoning = _pick_int(usage, "reasoning_tokens", "completion_tokens_details.reasoning_tokens") or legacy("reasoning_tokens")
    return {
        "input_tokens": max(prompt_total - cache_read - cache_write, 0),
        "output_tokens": completion,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
    }


def _bool_env(name: str, default: bool = False) -> bool:
    v = _env(name, "true" if default else "false")
    return (v or "false").strip().lower() in ("true", "1", "yes")


class MeterPalBridge(CustomLogger):
    """CustomLogger that delegates admission + metering to the MeterPal billing server."""

    def __init__(self) -> None:
        self.api_key: str = _env("API_KEY", "") or ""
        # The bearer presented to the billing server.  One deployment serves
        # every merchant, so it cannot present a merchant's secret key when
        # it bills a different merchant: it presents this shared secret and
        # names the tenant it resolved from the caller's virtual key.
        self.trust_secret: str = _env("TRUST_SECRET", "") or ""
        self.bearer: str = self.trust_secret or self.api_key
        self.env: str = _env("ENV", "sandbox") or "sandbox"
        self.base_url: str = _env("BASE_URL", "https://api.meterpal.dev/v1") or ""
        self.feature_id: str = _env("FEATURE_ID", "ai_tokens") or "ai_tokens"
        self.customer_header: str = _env("CUSTOMER_HEADER", "user") or "user"
        self.admit_mode: str = _env("ADMIT_MODE", "block") or "block"
        self.check_ttl: float = float(_env("CHECK_TTL_SEC", "1.0") or "1.0")
        self.timeout: float = float(_env("TIMEOUT_SEC", "2.0") or "2.0")
        self.fail_mode: str = _env("FAIL_MODE", "open") or "open"
        self.use_lock: bool = _bool_env("USE_LOCK", False)
        self.required_balance: float = float(_env("REQUIRED_BALANCE", "1.0") or "1.0")
        # Per-org ceilings.  One merchant cannot exhaust the shared provider
        # quota, however many customers it has.  Enforced against the
        # gateway's shared cache, so every gateway instance sees the same
        # budget.
        self.org_rpm_limit: int = int(_env("ORG_RPM_LIMIT", "600") or "600")
        self.org_tpm_limit: int = int(_env("ORG_TPM_LIMIT", "4000000") or "4000000")
        # How long the shared counter survives.  The counter is bucketed per
        # minute, so two minutes is enough for Redis to reclaim it once the
        # window it belongs to is over.
        self._org_counter_ttl_sec: int = 120
        self.model_id_map: dict[str, str] = {}
        raw_map = _env("MODEL_ID_MAP", "") or ""
        if raw_map.strip():
            try:
                self.model_id_map = {str(k): str(v) for k, v in json.loads(raw_map).items()}
            except json.JSONDecodeError as exc:
                # A silently-empty map bills under the raw model id, which
                # the billing server then rejects -- surface the misconfiguration.
                print(f"[MeterPalBridge] {_PREFIX}MODEL_ID_MAP is not valid JSON ({exc}); "
                      f"model ids will be passed through unmapped", flush=True)
                self.model_id_map = {}

        if not self.bearer:
            # Logged once at startup.  Bridge will no-op until configured.
            try:
                from litellm._logging import verbose_proxy_logger
                verbose_proxy_logger.warning(f"MeterPalBridge: {_PREFIX}API_KEY missing -- bridge disabled")
            except Exception:
                pass

        self._check_cache: dict[str, Tuple[float, Tuple[bool, Optional[str], Optional[dict], Optional[str]]]] = {}
        self._cache_lock = asyncio.Lock()
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={
                    "Authorization": f"Bearer {self.bearer}",
                    "Content-Type": "application/json",
                },
                params={"am-version": "V1_2"},
                timeout=self.timeout,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -------- helpers --------
    def _key_identity(self, uak: Optional[UserAPIKeyAuth]) -> Tuple[Optional[str], Optional[str]]:
        """The (org, customer) carried by the key itself.

        A MeterPal virtual key is minted with `<org>:<customer>` as its
        identity.  Only the master key can mint one, so this is the one place
        the tenant can be established -- a header the caller controls is not.
        """
        if uak is None:
            return (None, None)
        raw = getattr(uak, "user_id", None)
        if not raw:
            return (None, None)
        text = str(raw)
        if ":" not in text:
            return (None, None)
        org, _, customer = text.partition(":")
        if not org or not customer:
            return (None, None)
        return (org, customer)

    def _customer_id(self, data: Optional[dict], uak: Optional[UserAPIKeyAuth]) -> Optional[str]:
        # The key's own identity wins.  A header the caller controls must
        # never be able to redirect the charge to another customer.
        _, key_customer = self._key_identity(uak)
        if key_customer:
            return key_customer
        if data:
            for key in (self.customer_header, "user", "user_id", "end_user_id"):
                v = data.get(key)
                if v:
                    return str(v)
            md = data.get("metadata") or {}
            if isinstance(md, dict) and md.get("autumn_customer_id"):
                return str(md["autumn_customer_id"])
        if uak is not None and getattr(uak, "end_user_id", None):
            return uak.end_user_id
        return None

    def _litellm_metadata(self, kwargs: Optional[dict]) -> dict:
        if not kwargs:
            return {}
        return kwargs.get("metadata") or kwargs.get("litellm_params", {}).get("metadata") or {}

    def _post_call_customer_id(self, kwargs: dict) -> Optional[str]:
        """Resolve the customer after the call.

        The pre-call hook stashes the id in litellm metadata
        ("_autumn_customer_id"); that is the only field reliably present in
        the logging payload.  The remaining paths are best-effort fallbacks.
        """
        md = self._litellm_metadata(kwargs)
        return (
            md.get("_autumn_customer_id")
            or md.get("user_api_key_end_user_id")
            or kwargs.get("user_api_key_end_user_id")
            or self._customer_id(kwargs.get("litellm_params") or {}, None)
        )

    def _model_id(self, kwargs: dict) -> str:
        """Billable model id for the billing server.

        LiteLLM hands the hook either a bare alias ("demo-gpt") or a
        deployment string ("openai/demo-gpt"); the billing server prices by
        exact "<provider>/<model>" against models.dev, or "custom/<name>"
        against the credit feature's model_markups.  PAB_MODEL_ID_MAP bridges
        the two -- matched on the full id first, then the bare name after the
        last slash.  Unmapped ids pass through unchanged.
        """
        raw = str(kwargs.get("model") or "")
        if not raw:
            return ""
        if raw in self.model_id_map:
            return self.model_id_map[raw]
        bare = raw.split("/")[-1]
        return self.model_id_map.get(bare, raw)

    async def _billing_check(
        self,
        customer_id: str,
        org_id: Optional[str] = None,
        model_id: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> Tuple[bool, Optional[str], Optional[dict], Optional[str]]:
        """Admit the request, and pin the price it is admitted at.

        The billing server resolves the merchant's price for the model and
        returns it as `pricing.pinned_rates`.  Those rates are handed back on
        the settle call, so the reservation and the charge are made at the
        same price even if the merchant edits their price sheet in between.

        It also returns `pricing.model_id`: the id the charge must be
        recorded against.  The gateway names a model its own way ("demo-gpt")
        while the merchant's price sheet names it the way they bill it
        ("custom/demo-gpt"), and only the billing server knows which id
        belongs to this org.  Settling against the gateway's name would
        charge a different merchant's price row.
        """
        now = time.monotonic()
        # The tenant is part of the cache key: two orgs can have a customer
        # with the same id, and they are billed differently.
        cache_key = f"{org_id or ''}:{customer_id}:{model_id}"
        async with self._cache_lock:
            cached = self._check_cache.get(cache_key)
            if cached and (now - cached[0]) < self.check_ttl:
                return cached[1]

        body: dict[str, Any] = {
            "customer_id": customer_id,
            "feature_id": self.feature_id,
            "required_balance": self.required_balance,
        }
        if org_id:
            # The tenant this call belongs to.  It came from the caller's
            # virtual key, so the billing server can bill this org's customer
            # and no other.
            body["org_id"] = org_id
            body["env"] = self.env
        if model_id:
            body["model_id"] = model_id
            body["input_tokens"] = int(input_tokens or 0)
            body["output_tokens"] = int(output_tokens or 0)
        if self.use_lock:
            body["lock"] = True

        pinned_rates: Optional[dict] = None
        resolved_model_id: Optional[str] = None
        try:
            client = self._get_client()
            resp = await client.post("/check", json=body)
            resp.raise_for_status()
            payload = resp.json()
            allowed = bool(payload.get("allowed", False))
            lock_id = (payload.get("lock") or {}).get("lock_id") if self.use_lock else None
            pricing = payload.get("pricing") or {}
            pinned_rates = pricing.get("pinned_rates") or None
            resolved_model_id = pricing.get("model_id") or None
        except httpx.HTTPError as exc:
            await self._log(f"billing /check failed: {exc!r}")
            allowed = self.fail_mode == "open"
            lock_id = None
            pinned_rates = None
            resolved_model_id = None

        async with self._cache_lock:
            self._check_cache[cache_key] = (now, (allowed, lock_id, pinned_rates, resolved_model_id))
        return (allowed, lock_id, pinned_rates, resolved_model_id)

    async def _post_billing_with_retry(self, path: str, json_body: dict) -> None:
        # Money-movement POST with bounded retry: a transient billing-server
        # blip must not silently lose usage or leak a reservation. Retries
        # network errors and 5xx; 4xx are permanent (logged, not retried).
        # The billing server dedupes on idempotency keys, so retries are safe.
        delays = [0.5, 1.0, 2.0]
        last_error: Optional[str] = None
        for attempt in range(len(delays) + 1):
            try:
                client = self._get_client()
                resp = await client.post(path, json=json_body)
                if resp.status_code < 300:
                    return
                last_error = f"HTTP {resp.status_code}"
                if resp.status_code < 500:
                    break  # 4xx — the server rejected the payload; retrying won't help
            except httpx.HTTPError as exc:
                last_error = repr(exc)
            if attempt < len(delays):
                await asyncio.sleep(delays[attempt])
        await self._log(f"billing {path} failed after retries: {last_error}")

    async def _billing_finalize(self, customer_id: str, lock_id: str, action: str) -> None:
        try:
            await self._post_billing_with_retry(
                "/balances.finalize",
                {
                    "customer_id": customer_id,
                    "lock_id": lock_id,
                    "action": action,
                    # Commit releases the reservation in full — the actual
                    # usage is billed separately by /track_tokens. Without
                    # this the reserved amount is kept AND the real cost is
                    # deducted on top (double-billing).
                    **({"override_value": 0} if action == "commit" else {}),
                    "feature_id": self.feature_id,
                },
            )
        except httpx.HTTPError as exc:
            await self._log(f"billing /balances.finalize failed: {exc!r}")

    async def _billing_track_tokens(
        self,
        *,
        customer_id: str,
        org_id: Optional[str] = None,
        model_id: str,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        audio_input_tokens: int = 0,
        audio_output_tokens: int = 0,
        reasoning_tokens: int = 0,
        cost_usd: float = 0.0,
        request_id: str,
        status: str,
        error_type: Optional[str] = None,
        pinned_rates: Optional[dict] = None,
    ) -> None:
        body: dict[str, Any] = {
            "customer_id": customer_id,
            "feature_id": self.feature_id,
            "model_id": model_id,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read_tokens,
            "cache_write_tokens": cache_write_tokens,
            "audio_input_tokens": audio_input_tokens,
            "audio_output_tokens": audio_output_tokens,
            "reasoning_tokens": reasoning_tokens,
            # Never an empty idempotency key: the billing server skips its
            # dedupe claim when the key is absent, so a retry could
            # double-charge.
            "idempotency_key": request_id or str(uuid.uuid4()),
            # TrackTokensParamsSchema expects unix milliseconds.
            "timestamp": int(time.time() * 1000),
            "properties": {
                "model_id": model_id,
                "cost_usd": cost_usd,
                "litellm_call_id": request_id,
                "status": status,
                "error_type": error_type,
            },
        }
        if pinned_rates:
            # The rates this request was admitted at.  The billing server
            # bills at these verbatim, so the reservation and the charge are
            # the same price.
            body["pinned_rates"] = pinned_rates
        if org_id:
            # The tenant the charge belongs to.
            body["org_id"] = org_id
            body["env"] = self.env

        await self._post_billing_with_retry("/track_tokens", body)

    async def _log(self, msg: str) -> None:
        # Never log customer ids or API keys.  Billing failures MUST be
        # visible regardless of LiteLLM's log level — stderr always shows.
        import sys
        print(f"[MeterPalBridge] {msg}", file=sys.stderr, flush=True)
        try:
            from litellm._logging import verbose_proxy_logger
            verbose_proxy_logger.info(f"[MeterPalBridge] {msg}")
        except ImportError:
            pass

    def _estimate_input_tokens(self, data: dict) -> int:
        """Rough input-token count for the admission estimate.

        Only used to price the request BEFORE it runs; the actual charge is
        computed from the real token counts the provider reports.  A rough
        estimate is enough: it feeds `estimated_cost`, not the amount billed.
        """
        total = 0
        for message in data.get("messages") or []:
            content = message.get("content")
            if isinstance(content, str):
                total += len(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        total += len(str(part.get("text") or ""))
        # ~4 characters per token is the usual English approximation.
        return max(1, total // 4) if total else 1

    def _estimate_output_tokens(self, data: dict) -> int:
        """The caller's output cap, used for the admission estimate."""
        for key in ("max_tokens", "max_completion_tokens"):
            value = data.get(key)
            if isinstance(value, int) and value > 0:
                return value
        return 0

    async def _org_rate_limit(
        self,
        org_id: Optional[str],
        cache: Any,
        estimated_tokens: int,
    ) -> Optional[str]:
        """The org's own request and token ceilings.

        The counter is kept in the gateway's Redis, so the ceiling holds
        across every gateway instance -- the whole point of a per-org limit
        is that one merchant cannot exhaust the shared provider quota.  When
        no Redis cache is configured the gateway's own cache is used
        instead, which still holds within one instance.

        A limiter outage must not stop a merchant serving, so a failure
        here admits the request.
        """
        if not org_id:
            return None

        window = int(time.time() // 60)
        try:
            rpm = await self._increment_counter(
                f"meterpal:org_rpm:{org_id}:{window}", 1, cache
            )
            tpm = await self._increment_counter(
                f"meterpal:org_tpm:{org_id}:{window}",
                max(1, estimated_tokens),
                cache,
            )
        except Exception as exc:  # noqa: BLE001 -- a limiter must never break a call
            await self._log(f"org rate limit check failed: {exc!r}")
            return None

        if rpm is not None and rpm > self.org_rpm_limit:
            return f"more than {self.org_rpm_limit} requests per minute"
        if tpm is not None and tpm > self.org_tpm_limit:
            return f"more than {self.org_tpm_limit} tokens per minute"
        return None

    async def _increment_counter(
        self, key: str, value: int, cache: Any
    ) -> Optional[float]:
        """Increment a shared counter, preferring the gateway's Redis.

        `litellm.cache.cache` is the Redis cache the proxy was configured
        with -- the same one its own rate limiter uses.  It is read at call
        time because the cache is built during startup, after this module
        is imported.
        """
        # Imported here, not at module level: this module is loaded from
        # inside litellm's own package.
        import litellm

        redis_cache = getattr(getattr(litellm, "cache", None), "cache", None)
        if redis_cache is not None and hasattr(redis_cache, "async_increment"):
            # The counter is per minute window, so it may outlive its window
            # by one; the TTL lets Redis reclaim it.
            return await redis_cache.async_increment(
                key, value, ttl=self._org_counter_ttl_sec, refresh_ttl=False
            )
        if cache is not None:
            return await cache.async_increment_cache(key, value, refresh_ttl=False)
        return None

    # -------- Hook 1: admission --------
    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache: DualCache,
        data: dict,
        call_type: Any,
    ) -> dict:
        if not self.bearer:
            return data

        # The tenant comes from the key, never from the request.
        org_id, key_customer = self._key_identity(user_api_key_dict)

        customer_id = key_customer or self._customer_id(data, user_api_key_dict)
        if not customer_id:
            # Fail closed: an unresolvable identity means an unmetered model
            # call. Every billable request must name a customer.
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "missing_billing_identity",
                    "message": (
                        "No billing customer could be resolved for this "
                        "request. Pass 'user' (the MeterPal customer id)."
                    ),
                },
            )

        if self.trust_secret and not org_id:
            # The shared gateway secret is only used when the tenant can be
            # established from the key.  Without it the charge would land on
            # whichever org the request happened to name.
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "unresolvable_tenant",
                    "message": (
                        "This key does not carry a MeterPal tenant. Use a "
                        "MeterPal virtual key, not a gateway admin key."
                    ),
                },
            )

        # mirror the customer id so LiteLLM populates LiteLLM_EndUserTable.user_id
        data[self.customer_header] = customer_id
        data["user"] = customer_id

        estimated_input = self._estimate_input_tokens(data)
        estimated_output = self._estimate_output_tokens(data)

        # The org's ceiling.  Checked before the provider is touched, so an
        # over-quota merchant never spends anything.
        over_quota = await self._org_rate_limit(
            org_id, cache, estimated_input + estimated_output
        )
        if over_quota:
            raise HTTPException(
                status_code=429,
                detail={
                    "error": "rate_limit_exceeded",
                    "message": f"This organization sent {over_quota}.",
                    "org_id": org_id,
                },
            )

        model_id = self._model_id(data)
        allowed, lock_id, pinned_rates, resolved_model_id = await self._billing_check(
            customer_id,
            org_id=org_id,
            model_id=model_id,
            input_tokens=estimated_input,
            output_tokens=estimated_output,
        )
        if not allowed and self.admit_mode == "block":
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "insufficient_balance",
                    "customer_id": customer_id,
                    "feature_id": self.feature_id,
                },
            )

        md = data.setdefault("metadata", {})
        if lock_id:
            md["_autumn_lock_id"] = lock_id
        if pinned_rates:
            # The price this request is admitted at.  The settle call uses it
            # verbatim, so the charge matches the quote.
            md["_autumn_pinned_rates"] = pinned_rates
        if resolved_model_id:
            # The id the charge belongs to, resolved against this org's
            # price sheet by the billing server.
            md["_autumn_model_id"] = resolved_model_id
        if org_id:
            # The tenant the charge belongs to.  The settle call has to name
            # it again: the success hook only sees the logging payload.
            md["_autumn_org_id"] = org_id
        # Always carry the customer through to the logging payload -- the
        # success/failure hooks have no other reliable way to resolve it.
        md["_autumn_customer_id"] = customer_id
        return data

    # -------- Hook 2: billable success --------
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        if not self.bearer:
            return
        customer_id = self._post_call_customer_id(kwargs)
        if not customer_id:
            return
        md = self._litellm_metadata(kwargs)
        lock_id = md.get("_autumn_lock_id")
        if self.use_lock and lock_id:
            await self._billing_finalize(customer_id, lock_id, "commit")
        usage = _usage_breakdown(kwargs, response_obj)
        await self._billing_track_tokens(
            customer_id=customer_id,
            org_id=md.get("_autumn_org_id"),
            model_id=md.get("_autumn_model_id") or self._model_id(kwargs),
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cache_read_tokens=usage["cache_read_tokens"],
            cache_write_tokens=usage["cache_write_tokens"],
            reasoning_tokens=usage["reasoning_tokens"],
            cost_usd=float(kwargs.get("response_cost") or 0.0),
            request_id=str(kwargs.get("litellm_call_id") or ""),
            status="success",
            pinned_rates=md.get("_autumn_pinned_rates"),
        )

    # -------- Hook 3: failure path --------
    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        if not self.bearer:
            return
        customer_id = self._post_call_customer_id(kwargs)
        if not customer_id:
            return
        md = self._litellm_metadata(kwargs)
        lock_id = md.get("_autumn_lock_id")
        if self.use_lock and lock_id:
            await self._billing_finalize(customer_id, lock_id, "release")
        usage = _usage_breakdown(kwargs, response_obj)
        exc = kwargs.get("exception")
        await self._billing_track_tokens(
            customer_id=customer_id,
            org_id=md.get("_autumn_org_id"),
            model_id=md.get("_autumn_model_id") or self._model_id(kwargs),
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cache_read_tokens=usage["cache_read_tokens"],
            cache_write_tokens=usage["cache_write_tokens"],
            reasoning_tokens=usage["reasoning_tokens"],
            cost_usd=0.0,
            request_id=str(kwargs.get("litellm_call_id") or ""),
            status="failure",
            error_type=exc.__class__.__name__ if exc else None,
            pinned_rates=md.get("_autumn_pinned_rates"),
        )


# Module-level singleton.  LiteLLM's custom-callback loader requires the
# config to name an *instance* (a class is neither a CustomLogger instance nor
# a callable), so config.yaml registers:
#   callbacks: ["litellm.integrations.meterpal_billing.proxy_handler_instance"]
# Instantiated at import time, which is when env vars are read.
proxy_handler_instance = MeterPalBridge()
meterpal_bridge_instance = proxy_handler_instance
