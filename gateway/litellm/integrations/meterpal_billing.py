"""
litellm/integrations/meterpal_billing.py

MeterPal usage-billing bridge between the LiteLLM proxy and the MeterPal
billing server (a PayPal-native fork of Autumn).  Mirrors
litellm/proxy/hooks/proxy_track_cost_callback.py.

Responsibilities:
  1. async_pre_call_hook     -> billing POST /check  (admission + reservation)
  2. async_log_success_event -> billing POST /track_tokens (per-token debit)
                                then POST /balances.finalize (release the hold)
  3. async_log_failure_event -> billing POST /track_tokens (failure record)
                                then POST /balances.finalize (release the hold)

Concurrency:
  The admission decision is per request and is NEVER cached.  An earlier
  version cached the whole /check response for PAB_CHECK_TTL_SEC, which meant
  that N concurrent requests from one customer inside the TTL shared a single
  verdict AND a single reservation id: the first settle consumed the hold and
  the rest were billed against a balance nothing was held for.  The cache is
  gone; every request gets its own check and its own hold.

  The reservation is sized from the request's own price: the gateway sends a
  worst-case token estimate, the billing server prices it at the org's rates,
  and holds that much.  With PAB_MAX_OUTPUT_TOKENS as the ceiling for a
  request that does not cap its own output.

Usage tokens are read from response_obj.usage (a litellm Usage object) --
kwargs["usage"] is usually None in current LiteLLM.  The customer id
is carried from the pre-call hook through litellm metadata
("_autumn_customer_id" -- the metadata key is a cross-service contract with
the billing server's virtual-key provisioning, which stamps the same key on
generated keys) because top-level end-user fields are also absent post-call.

Security:
  - All credentials read from environment, never logged.
  - Idempotency: every track_tokens call uses kwargs['litellm_call_id'] (UUID)
    as its idempotency key.  Every check carries a request id, and the
    billing server derives the reservation id from it, so a repeated
    admission for the same request resolves to the same hold instead of
    taking a second one.
  - Fail-open by default (configurable); logged.
  - Admission short-circuit raises HTTPException(402) before any provider call.

Configuration (env).  PAB_* names are primary; legacy AUTUMN_* names are
honored as fallbacks so pre-existing deployments keep working:
  PAB_BASE_URL           default https://api.meterpal.dev/v1
  PAB_API_KEY            required -- bearer token (am_sk_...)
  PAB_FEATURE_ID         default ai_tokens
  PAB_CUSTOMER_HEADER    default user
  PAB_ADMIT_MODE         block | soft
  PAB_TIMEOUT_SEC        default 2.0
  PAB_FAIL_MODE          open | closed
  PAB_USE_LOCK           true | false -- default TRUE.  The reservation is
                         what bounds concurrent spend; without it N concurrent
                         requests each see the full balance and all proceed.
  PAB_REQUIRE_LOCK       true | false -- default TRUE.  Refuse a request the
                         billing server admitted without taking a reservation
                         for it.  Set false only while rolling the gateway
                         out ahead of a billing server that does not return
                         reservation ids yet.
  PAB_REQUIRED_BALANCE   minimum balance /check demands (default 1.0 --
                         the billing server's own default; a call may start
                         only when the customer holds at least this much).
                         This is a FLOOR: the reservation is sized from the
                         request's price and is usually larger.
  PAB_MAX_OUTPUT_TOKENS  default 8192 -- the output ceiling for a request
                         that does not cap its own output.  It is both the
                         worst-case estimate the reservation is sized from and
                         the cap the request is refused above.
  PAB_LOCK_TTL_SEC       default 900 -- how long a reservation may live before
                         the billing server releases it automatically.  A
                         request that never settles (a client that disconnects
                         before the first token) is released by this, not held
                         forever.
  PAB_ORG_RPM_LIMIT      default 600 -- per-org requests per minute
  PAB_ORG_TPM_LIMIT      default 4000000 -- per-org tokens per minute
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
    # The billing server's cost model adds reasoning tokens ON TOP of output
    # tokens.  When the provider reports reasoning as a DETAIL of
    # completion_tokens (OpenAI o-series and most chat models), completion
    # already includes it — send the non-reasoning portion as output so the
    # two add up to the real completion total instead of double-counting it.
    detail_reasoning = _pick_int(usage, "completion_tokens_details.reasoning_tokens") or 0
    output_for_billing = completion
    if detail_reasoning and detail_reasoning <= completion:
        output_for_billing = max(completion - detail_reasoning, 0)
    return {
        "input_tokens": max(prompt_total - cache_read - cache_write, 0),
        "output_tokens": output_for_billing,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
    }


def _usage_is_empty(usage: dict) -> bool:
    """Whether the provider reported no usage at all.

    Zero usage is not the same as no usage.  A request that failed before
    the provider reported anything may still have consumed tokens; recording
    that as a zero-cost request gives the usage away and hides the gap.
    """
    return not any(
        int(usage.get(key) or 0) > 0
        for key in (
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "reasoning_tokens",
        )
    )


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
        self.timeout: float = float(_env("TIMEOUT_SEC", "2.0") or "2.0")
        self.fail_mode: str = _env("FAIL_MODE", "open") or "open"
        # The reservation is on by default.  It is the only thing that bounds
        # concurrent spend: without a hold, N concurrent requests each see the
        # whole balance and every one of them is admitted.
        self.use_lock: bool = _bool_env("USE_LOCK", True)
        # Whether a missing reservation refuses the request.  On by default:
        # an unreserved request is an unheld charge.  It exists as a knob for
        # rolling the gateway out ahead of a billing server that does not yet
        # return reservation ids.
        self.require_lock: bool = _bool_env("REQUIRE_LOCK", True)
        self.required_balance: float = float(_env("REQUIRED_BALANCE", "1.0") or "1.0")
        # The output ceiling for a request that does not cap its own output.
        # It is both the worst-case estimate the reservation is sized from and
        # the cap a request is refused above.
        self.max_output_tokens: int = int(
            _env("MAX_OUTPUT_TOKENS", "8192") or "8192"
        )
        # How long a reservation may live before the billing server releases
        # it.  A request that never settles -- a client that disconnects
        # before the first token -- would otherwise hold the balance until
        # the receipt's own expiry, a day away.
        self.lock_ttl_sec: int = int(_env("LOCK_TTL_SEC", "900") or "900")
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
        request_id: str = "",
    ) -> Tuple[bool, Optional[str], Optional[dict], Optional[str]]:
        """Admit the request, reserve against its balance, and pin its price.

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

        There is deliberately no cache here.  The admission decision and the
        reservation belong to one request: a cached verdict is a stale
        balance, and a cached reservation id is one hold shared by every
        request that read it.  Both are wrong the moment two requests
        overlap, which is exactly when it matters.
        """
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
            # The object form, not a bare boolean.  The server's schema takes
            # an object with `enabled`; a boolean is a 400, and the fail-open
            # path would turn that 400 into "admitted, with nothing reserved
            # and no price pinned" -- the failure mode this whole path
            # exists to prevent.
            body["lock"] = {
                "enabled": True,
                # The hold is released automatically if the request never
                # settles.  A client that disconnects before the first token
                # never reaches either settle hook, so without this the
                # balance stays held until the receipt expires on its own.
                "expires_at": int((time.time() + self.lock_ttl_sec) * 1000),
            }
            if request_id:
                # The billing server derives the reservation id from this
                # key, so a repeated admission for the same request resolves
                # to the same hold instead of taking a second one.
                body["idempotency_key"] = request_id

        pinned_rates: Optional[dict] = None
        resolved_model_id: Optional[str] = None
        lock_id: Optional[str] = None
        try:
            client = self._get_client()
            resp = await client.post("/check", json=body)
            resp.raise_for_status()
            payload = resp.json()
            allowed = bool(payload.get("allowed", False))
            lock = payload.get("lock") or {}
            lock_id = lock.get("lock_id") or None
            pricing = payload.get("pricing") or {}
            pinned_rates = pricing.get("pinned_rates") or None
            resolved_model_id = pricing.get("model_id") or None
        except httpx.HTTPError as exc:
            await self._log(f"billing /check failed: {exc!r}")
            allowed = self.fail_mode == "open"
            lock_id = None
            pinned_rates = None
            resolved_model_id = None

        if self.use_lock and allowed and not lock_id:
            # A reservation was asked for and none came back.  Serving the
            # request anyway would be an unreserved charge: the balance
            # would not hold anything, so N concurrent requests would each
            # see the whole balance and all be admitted.
            await self._log(
                "billing /check returned no reservation id; the request is not reserved"
            )
            if self.require_lock:
                allowed = False
            lock_id = None

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
                    # 4xx — the server rejected the payload; retrying won't
                    # help.  A rejected money POST is a lost charge or a
                    # leaked reservation: dead-letter it loudly so it can be
                    # reconciled by hand instead of vanishing silently.
                    # (Payload only — the auth header never enters this log.)
                    await self._log(
                        f"RECONCILE-NEEDED path={path} status={resp.status_code} "
                        f"payload={json.dumps(json_body, default=str)[:2000]}"
                    )
                    break
            except httpx.HTTPError as exc:
                last_error = repr(exc)
            if attempt < len(delays):
                await asyncio.sleep(delays[attempt])
        await self._log(f"billing {path} failed after retries: {last_error}")

    async def _billing_finalize(
        self,
        customer_id: str,
        lock_id: str,
        action: str,
        org_id: Optional[str] = None,
    ) -> None:
        body: dict[str, Any] = {
            "customer_id": customer_id,
            "lock_id": lock_id,
            "action": action,
            # Commit releases the reservation in full -- the actual usage is
            # billed separately by /track_tokens.  Without this the reserved
            # amount is kept AND the real cost is deducted on top
            # (double-billing).
            **({"override_value": 0} if action == "commit" else {}),
            "feature_id": self.feature_id,
        }
        if org_id:
            # The tenant this call belongs to.  Without it the billing
            # server refuses the call: the gateway has to name the tenant it
            # resolved from the caller's key on every request, not just the
            # ones that carry a customer id.
            body["org_id"] = org_id
            body["env"] = self.env
        try:
            await self._post_billing_with_retry("/balances.finalize", body)
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
        overage_behavior: Optional[str] = None,
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
        if overage_behavior:
            body["overage_behavior"] = overage_behavior
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

        It does have to be an over-estimate rather than an under-estimate:
        the reservation is sized from it, and an estimate that leaves out the
        system prompt or the tool schemas holds less than the request can
        spend.
        """
        total = 0

        def _count(content: Any) -> None:
            nonlocal total
            if isinstance(content, str):
                total += len(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        total += len(str(part.get("text") or ""))

        for message in data.get("messages") or []:
            if isinstance(message, dict):
                _count(message.get("content"))

        # The system prompt and the tool schemas are billed as input too, and
        # they are often the larger half of the request.
        for key in ("system", "instructions"):
            _count(data.get(key))
        for tool in data.get("tools") or []:
            if isinstance(tool, dict):
                total += len(json.dumps(tool, default=str))

        # ~4 characters per token is the usual English approximation.
        return max(1, total // 4) if total else 1

    def _estimate_output_tokens(self, data: dict) -> int:
        """The worst-case output for the admission estimate.

        The caller's own cap is the best possible bound, so it is used when
        there is one.  When there is not, the gateway's ceiling stands in:
        an estimate of zero holds nothing, and the request can spend the
        whole balance.
        """
        for key in ("max_tokens", "max_completion_tokens"):
            value = data.get(key)
            if isinstance(value, int) and value > 0:
                return value
        return self.max_output_tokens

    def _requested_output_cap(self, data: dict) -> Optional[int]:
        """The caller's own output cap, if it set one."""
        for key in ("max_tokens", "max_completion_tokens"):
            value = data.get(key)
            if isinstance(value, int) and value > 0:
                return value
        return None

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

        # The per-request ceiling.  One request must not be able to spend a
        # customer's whole balance, whatever the balance is.
        requested_cap = self._requested_output_cap(data)
        if requested_cap is not None and requested_cap > self.max_output_tokens:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "output_cap_exceeded",
                    "message": (
                        f"This request asks for up to {requested_cap} output "
                        f"tokens; the ceiling is {self.max_output_tokens}."
                    ),
                },
            )

        # One id for the whole request: the reservation id is derived from
        # it, and the settle call carries it as the idempotency key, so a
        # retry of either resolves to the same thing.
        request_id = str(
            data.get("litellm_call_id")
            or data.get("metadata", {}).get("_autumn_request_id")
            or uuid.uuid4()
        )

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
            request_id=request_id,
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
        # The settle contract (_autumn_* / _meterpal_*) must never be readable
        # from the caller's request.  `metadata` is client-supplied, so a
        # caller could otherwise inject _autumn_pinned_rates (zero rates =
        # free usage) or _autumn_model_id (bill a cheaper model's price row)
        # and have them survive every hook where the check response did not
        # overwrite them.  Strip before stashing this request's own values.
        for _poison in [
            k
            for k in md
            if k.startswith("_autumn_") or k.startswith("_meterpal_")
        ]:
            md.pop(_poison, None)
        md["_autumn_request_id"] = request_id
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
        usage = _usage_breakdown(kwargs, response_obj)
        # A request that produced no usage at all is not a free request: the
        # provider may have burned tokens that were never reported.  It is
        # recorded as unreconciled so it can be found, not as a zero-cost
        # success.
        status = "success" if not _usage_is_empty(usage) else "unreconciled"
        request_id = str(
            kwargs.get("litellm_call_id") or md.get("_autumn_request_id") or ""
        )
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
            request_id=request_id,
            status=status,
            pinned_rates=md.get("_autumn_pinned_rates"),
            # The hold is still held while this is charged, so the charge has
            # to be allowed past the remaining balance and be brought back by
            # the release below.  Capping it here would leave the customer
            # under-charged for a request the hold already admitted.
            overage_behavior="overflow" if lock_id else None,
        )
        if self.use_lock and lock_id:
            # Release the hold AFTER the charge.  Releasing first put the
            # whole balance back while the charge was still pending, and
            # another request could take it in that window.  This way the
            # balance only ever goes down.
            await self._billing_finalize(
                customer_id, lock_id, "commit", org_id=md.get("_autumn_org_id")
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
        usage = _usage_breakdown(kwargs, response_obj)
        exc = kwargs.get("exception")
        # A failure that produced usage is charged for it: the provider did
        # the work.  A failure that produced no usage is unknown usage, not
        # zero usage.
        status = "failure" if not _usage_is_empty(usage) else "unreconciled"
        request_id = str(
            kwargs.get("litellm_call_id") or md.get("_autumn_request_id") or ""
        )
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
            request_id=request_id,
            status=status,
            error_type=exc.__class__.__name__ if exc else None,
            pinned_rates=md.get("_autumn_pinned_rates"),
            overage_behavior="overflow" if lock_id else None,
        )
        if self.use_lock and lock_id:
            await self._billing_finalize(
                customer_id, lock_id, "release", org_id=md.get("_autumn_org_id")
            )


# Module-level singleton.  LiteLLM's custom-callback loader requires the
# config to name an *instance* (a class is neither a CustomLogger instance nor
# a callable), so config.yaml registers:
#   callbacks: ["litellm.integrations.meterpal_billing.proxy_handler_instance"]
# Instantiated at import time, which is when env vars are read.
proxy_handler_instance = MeterPalBridge()
meterpal_bridge_instance = proxy_handler_instance
