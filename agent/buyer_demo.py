#!/usr/bin/env python3
"""Agent-as-buyer demo — an autonomous agent that buys its own AI credits.

The purest agentic-commerce loop on PayPal rails:

  1. The agent hits its headroom limit: the gateway returns HTTP 402 BEFORE
     the model is called (admission control, no provider spend).
  2. The agent decides on its own to buy a credit pack: it creates a PayPal
     order through the MeterPal API and prints the approval link.
  3. The buyer approves in PayPal (sandbox popup in the demo — real consent,
     no credentials shared with the agent).
  4. PAYMENT.CAPTURE.COMPLETED lands on the webhook; the wallet is credited.
  5. The agent re-tries its task and succeeds — balance now debited by the
     metered cost.

Run (after `python demo/bootstrap.py`, gateway + mock LLM + billing up):
  python agent/buyer_demo.py

Env: METERPAL_SECRET_KEY (billing), LITELLM_MASTER_KEY + LITELLM_URL
(gateway, default :4000), CUSTOMER_ID (default demo-customer).
"""

from __future__ import annotations

import os
import sys
import time
import webbrowser

import httpx

from meterpal import MeterPalClient, MeterPalError

BILLING_URL = os.environ.get("METERPAL_BASE_URL", "http://localhost:8080/v1")
SECRET_KEY = os.environ.get("METERPAL_SECRET_KEY", "")
GATEWAY = os.environ.get("LITELLM_URL", "http://localhost:4000")
MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
CUSTOMER_ID = os.environ.get("CUSTOMER_ID", "demo-customer")
TOPUP_PRODUCT = os.environ.get("METERPAL_TOPUP_PRODUCT", "topup_1k")
FEATURE_ID = os.environ.get("METERPAL_FEATURE_ID", "ai_tokens")

if not SECRET_KEY or not MASTER_KEY:
    sys.exit("Set METERPAL_SECRET_KEY and LITELLM_MASTER_KEY (see demo/README.md).")

billing = MeterPalClient(secret_key=SECRET_KEY, base_url=BILLING_URL)


def show_balance(label: str) -> float:
    bal = billing.get_customer_balance(CUSTOMER_ID, FEATURE_ID)
    remaining = bal.get("remaining")
    print(f"  {label}: {remaining} credits")
    return float(remaining or 0)


def agent_task(prompt: str) -> httpx.Response:
    """The agent's actual work: one AI call through the metered gateway."""
    return httpx.post(
        f"{GATEWAY}/v1/chat/completions",
        headers={"Authorization": f"Bearer {MASTER_KEY}"},
        json={
            "model": "demo-gpt",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 50,
            "user": CUSTOMER_ID,
        },
        timeout=60,
    )


def main() -> None:
    print("Agent-as-buyer: autonomous credit purchase over PayPal\n")

    print("1) Agent starts working; wallet has whatever is left:")
    show_balance("balance before")

    print("\n2) Agent calls the gateway — admission control decides:")
    resp = agent_task("Summarize the MeterPal billing loop in one sentence.")
    if resp.status_code == 402:
        print("  -> HTTP 402 insufficient_balance (refused BEFORE the provider was touched)")
    elif resp.status_code == 200:
        print("  -> call succeeded; balance now:")
        show_balance("balance after")
        print("\nWallet still has credit — drain it first (python demo/run_demo.py phase 4), then re-run.")
        return
    else:
        sys.exit(f"  -> unexpected gateway response: {resp.status_code} {resp.text[:200]}")

    print("\n3) Agent decides to buy credits (autonomous purchase decision):")
    print(f"  -> creating PayPal order for product {TOPUP_PRODUCT!r}...")
    try:
        checkout = billing.checkout(CUSTOMER_ID, TOPUP_PRODUCT)
    except MeterPalError as exc:
        sys.exit(
            f"  -> checkout failed: {exc}\n"
            "     PayPal sandbox keys must be set in billing/server/.env and the "
            "catalog synced (bun scripts/paypalCatalog.ts)."
        )
    approval_url = checkout.get("url")
    print(f"  -> approval link: {approval_url}")

    print("\n4) Buyer approves in PayPal (sandbox popup — real consent step):")
    if approval_url:
        try:
            webbrowser.open(approval_url)
        except Exception:
            pass
        print("  -> open the link above and pay with the sandbox buyer account.")
    print("  -> waiting for PAYMENT.CAPTURE.COMPLETED webhook to credit the wallet...")

    deadline = time.time() + 300
    credited = False
    while time.time() < deadline:
        bal = billing.get_customer_balance(CUSTOMER_ID, FEATURE_ID)
        if float(bal.get("remaining") or 0) >= 0.5:
            credited = True
            break
        time.sleep(3)
    if not credited:
        sys.exit("  -> timed out waiting for the webhook (did the approval + capture complete?)")
    show_balance("balance after top-up")

    print("\n5) Agent retries its task and succeeds:")
    resp = agent_task("Summarize the MeterPal billing loop in one sentence.")
    if resp.status_code == 200:
        reply = resp.json()["choices"][0]["message"]["content"]
        print(f"  -> 200 OK: {reply.strip()[:120]}...")
        show_balance("balance after call")
        print("\n✅ Loop complete: 402 → agent-initiated PayPal purchase → webhook "
              "credit → task resumes. No human touched the billing code.")
    else:
        sys.exit(f"  -> unexpected: {resp.status_code} {resp.text[:200]}")


if __name__ == "__main__":
    main()
