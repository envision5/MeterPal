"""A live check of the Python SDK against the running stack.

    py -3.12 sdk/python/scripts/live_check.py

The Python twin of sdk/typescript/scripts/live-check.ts: the same five
steps, the same environment variables, the same exit code.  Run it after
``pip install -e sdk/python`` and after demo/bootstrap.py has seeded the
stack.

Environment:
    METERPAL_SECRET_KEY   the merchant secret key (PAB_API_KEY in gateway/.env)
    METERPAL_BASE_URL     the billing server (default http://localhost:8080)
    METERPAL_FEATURE_ID   the meter (default ai_tokens)

Exit code 0 means every assertion held.  Any failure exits 1.
"""

from __future__ import annotations

import os
import sys

try:
    from meterpal import (
        InsufficientBalanceError,
        MeterPalClient,
        ModelNotFoundError,
        create_meterpal,
    )
except ModuleNotFoundError:  # pragma: no cover - the setup message is the point
    sys.exit(
        "live_check: the `meterpal` package is not importable.\n"
        "  Install it from this repo first:\n"
        "    py -3.12 -m pip install -e sdk/python\n"
        "  (use `python -m pip` so pip and python are the same interpreter)"
    )

BASE_URL = (os.environ.get("METERPAL_BASE_URL") or "http://localhost:8080").rstrip("/")
API_KEY = os.environ.get("METERPAL_SECRET_KEY")
FEATURE_ID = os.environ.get("METERPAL_FEATURE_ID") or "ai_tokens"

#: Dedicated paywall probe: step 5 spends this wallet to zero, so it must not
#: touch the customer the earlier steps bill.
PAYWALL_USER = "meterpal-livecheck-paywall"

#: ASCII markers on purpose.  A Windows console on a legacy codepage raises
#: UnicodeEncodeError on ✓, and a check script that crashes while reporting
#: success is worse than a plain one.
PASS = "[pass]"
FAIL = "[fail]"

_failures = 0


def check(ok: bool, message: str) -> None:
    global _failures
    if ok:
        print(f"   {PASS} {message}")
        return
    _failures += 1
    print(f"   {FAIL} {message}", file=sys.stderr)


def main() -> int:
    if not API_KEY:
        print(
            "live_check: set METERPAL_SECRET_KEY "
            "(demo: demo/bootstrap.py writes it to gateway/.env as PAB_API_KEY)",
            file=sys.stderr,
        )
        return 1

    print(f"live check against {BASE_URL}")
    print(f"key {API_KEY[:12]}..., feature {FEATURE_ID}")
    print()

    meterpal = create_meterpal(API_KEY, base_url=BASE_URL)

    # ---- 1. catalog -----------------------------------------------------
    print("1. the merchant's served catalog")
    try:
        catalog = meterpal.models.list()
    except Exception as error:  # setup failure, not an SDK failure
        print(
            f"\nlive_check: FAILED -- cannot read the catalog from {BASE_URL}",
            file=sys.stderr,
        )
        print(f"  {type(error).__name__}: {error}", file=sys.stderr)
        print("\n  Is the stack up?", file=sys.stderr)
        print("    docker compose up -d", file=sys.stderr)
        print("    python demo/bootstrap.py --migrate", file=sys.stderr)
        print("  Is the key current? bootstrap.py re-mints it on every run:", file=sys.stderr)
        print(
            "    export METERPAL_SECRET_KEY=$(grep '^PAB_API_KEY=' gateway/.env | cut -d= -f2)",
            file=sys.stderr,
        )
        return 1

    models = catalog.get("models", []) if isinstance(catalog, dict) else []
    for model in models:
        print(
            f"   {model.get('model_id')} ({model.get('upstream_model') or '-'}) "
            f"enabled={model.get('enabled')} "
            f"in={model.get('input_cost_usd_1m')} out={model.get('output_cost_usd_1m')} per 1M"
        )
    check(len(models) > 0, "the catalog lists at least one served model")

    # ---- 2. a metered call ----------------------------------------------
    print()
    print("2. a metered call")
    completion = meterpal.chat.completions.create(
        model="custom/demo-gpt",
        messages=[{"role": "user", "content": "Python SDK live check"}],
        user="demo-customer",
    )
    block = completion.get("meterpal") or {}
    print(f"   {completion['choices'][0]['message']['content']}")
    print(
        f"   charged {block.get('credits_charged')} credits, "
        f"balance now {block.get('balance_after')} "
        f"(model {block.get('model_id')}, "
        f"{block.get('input_tokens')} in / {block.get('output_tokens')} out)"
    )
    check(
        isinstance(block.get("credits_charged"), (int, float))
        and block["credits_charged"] > 0,
        "the call reports a non-zero credits_charged",
    )
    check(
        block.get("customer_id") == "demo-customer",
        "the charge is attributed to the end user in `user`",
    )

    # ---- 3. a streamed call ---------------------------------------------
    print()
    print("3. a streamed call")
    text = ""
    streamed = None
    for chunk in meterpal.chat.completions.stream(
        model="custom/demo-gpt",
        messages=[{"role": "user", "content": "Python streaming check"}],
        user="demo-customer",
    ):
        if chunk.get("meterpal"):
            streamed = chunk["meterpal"]
        choices = chunk.get("choices") or [{}]
        text += (choices[0].get("delta") or {}).get("content") or ""
    print(f"   {text}")
    print(f"   charged {(streamed or {}).get('credits_charged')} credits")
    check(len(text) > 0, "the stream yields content chunks")
    check(
        isinstance((streamed or {}).get("credits_charged"), (int, float))
        and (streamed or {}).get("credits_charged") > 0,
        "the final stream payload carries the charge",
    )

    # ---- 4. an unknown model is refused ---------------------------------
    print()
    print("4. an unknown model is refused")
    try:
        meterpal.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "x"}],
            user="demo-customer",
        )
        check(False, "an off-sheet model was refused")
    except ModelNotFoundError as error:
        print(f"   refused: {error}")
        check(True, "an off-sheet model was refused")
    except Exception as error:
        check(False, f"the refusal raised {type(error).__name__}, not ModelNotFoundError")

    # ---- 5. the paywall -------------------------------------------------
    print()
    print("5. a customer who cannot pay hits the paywall")
    # Deterministic: create the probe customer, set its wallet to zero, then
    # call.  Trusting a demo customer to be "broke" made this pass silently
    # whenever an earlier run had topped it up.
    billing = MeterPalClient(secret_key=API_KEY, base_url=f"{BASE_URL}/v1")
    billing.get_or_create_customer(PAYWALL_USER)
    check(True, "the paywall probe customer exists")
    billing.update_balance(PAYWALL_USER, FEATURE_ID, remaining=0)
    check(True, "the probe wallet is set to 0")

    try:
        meterpal.chat.completions.create(
            model="custom/demo-gpt",
            messages=[{"role": "user", "content": "x"}],
            user=PAYWALL_USER,
        )
        check(False, "a customer with no credits was refused with 402")
    except InsufficientBalanceError as error:
        print(
            f"   paywall: balance {error.balance}, needs {error.required_credits}, "
            f"customer {error.customer_id}"
        )
        print(f"   top_up() is wired: {callable(getattr(error, 'top_up', None))}")
        check(True, "a customer with no credits was refused with 402")
        check(
            callable(getattr(error, "top_up", None)),
            "the paywall error can open a checkout",
        )
    except Exception as error:
        check(
            False,
            f"the paywall raised {type(error).__name__}, not InsufficientBalanceError",
        )

    print()
    if _failures:
        print(f"SDK live check: FAILED ({_failures} checks)", file=sys.stderr)
        return 1
    print("SDK live check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
