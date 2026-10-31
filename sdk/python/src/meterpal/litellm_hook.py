"""LiteLLM gateway hook for MeterPal.

The hook pre-authorizes every chat completion against the customer's wallet
(`POST /check` — HTTP 402 before the provider is touched when the balance is
too low) and meters actual token usage after the call (`/track_tokens`,
idempotent per LiteLLM call id).

It ships inside the MeterPal gateway fork
(`gateway/litellm/integrations/meterpal_billing.py`); this module re-exports
it for pip installs of `meterpal[litellm]` against a stock LiteLLM proxy.

Usage (stock LiteLLM `config.yaml`):

    litellm_settings:
      callbacks: ["meterpal.litellm_hook.instance"]

Environment (PAB_* names; legacy AUTUMN_* still honored):

    PAB_API_KEY=am_sk_...            # billing server secret key
    PAB_BASE_URL=http://localhost:8080/v1
    PAB_REQUIRED_BALANCE=0.5
    PAB_FAIL_MODE=open               # open|closed — closed in production
    PAB_MODEL_ID_MAP={"my-alias": "custom/my-model"}
"""

from __future__ import annotations


def get_bridge():
    """Return the configured MeterPalBridge instance (imports litellm lazily)."""
    try:
        from litellm.integrations.meterpal_billing import proxy_handler_instance
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise ImportError(
            "meterpal.litellm_hook requires the litellm package. "
            "Install with: pip install 'meterpal[litellm]'"
        ) from exc
    return proxy_handler_instance


def __getattr__(name: str):
    # `from meterpal.litellm_hook import instance` resolves lazily so that
    # importing meterpal.litellm_hook without litellm installed stays harmless.
    if name == "instance":
        return get_bridge()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
