#!/usr/bin/env python3
"""Merchant agent demo — an AI agent managing the AI-billing workflow.

Scenario (the one in the hackathon video):

  1. "Show me customers running low on AI credits."
  2. "Show me this customer's AI spend, by model."
  3. "Issue them a PayPal invoice for the overage."

Run modes:

  python merchant_demo.py              # scripted: no LLM key needed, same tool calls
  python merchant_demo.py --llm        # OpenAI-compatible function calling
                                      # (OPENAI_API_KEY, optional OPENAI_BASE_URL)

Prereqs: billing server on :8080 (billing/), meterpal SDK installed
(pip install -e sdk/python), seeded customers (python demo/bootstrap.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from meterpal import MeterPalClient, MeterPalError

BASE_URL = os.environ.get("METERPAL_BASE_URL", "http://localhost:8080/v1")
SECRET_KEY = os.environ.get("METERPAL_SECRET_KEY", "")
FEATURE_ID = os.environ.get("METERPAL_FEATURE_ID", "ai_tokens")

if not SECRET_KEY:
    sys.exit("Set METERPAL_SECRET_KEY (the billing server secret key, am_sk_...)")

billing = MeterPalClient(secret_key=SECRET_KEY, base_url=BASE_URL)


# --------------------------------------------------------------------------
# Tools (the exact operations the MCP server exposes; the LLM mode registers
# these as function-calling tools, the scripted mode calls them in order)
# --------------------------------------------------------------------------


def tool_list_low_balance_customers(below_credits: float = 0.5) -> dict:
    customers = billing._request("POST", "/customers/list", {"limit": 100}) or {}
    rows = customers.get("items") or customers.get("customers") or []
    low = []
    for c in rows:
        for bal in c.get("balances") or []:
            if (bal.get("feature_id") or bal.get("feature", {}).get("id")) == FEATURE_ID:
                remaining = bal.get("remaining")
                if remaining is not None and remaining < below_credits:
                    low.append(
                        {
                            "customer_id": c.get("id"),
                            "email": c.get("email"),
                            "credits": remaining,
                            "paypal_payment_status": c.get("paypal_payment_status"),
                        }
                    )
    low.sort(key=lambda r: r["credits"])
    return {"threshold_credits": below_credits, "count": len(low), "customers": low}


def tool_get_customer_usage(customer_id: str, days: int = 30) -> dict:
    events = billing._request(
        "POST",
        "/events/list",
        {
            "customer_id": customer_id,
            "feature_id": FEATURE_ID,
            "limit": 500,
            "custom_range": {"start": __import__("time").time() * 1000 - days * 86_400_000},
        },
    ) or {}
    by_model: dict[str, dict] = {}
    total = 0.0
    for evt in events.get("list") or []:
        model = (evt.get("properties") or {}).get("model_id", "other")
        value = float(evt.get("value") or 0)
        total += value
        entry = by_model.setdefault(model, {"credits": 0.0, "requests": 0})
        entry["credits"] += value
        entry["requests"] += 1
    return {
        "customer_id": customer_id,
        "window_days": days,
        "credits_spent": round(total, 4),
        "by_model": by_model,
    }


def tool_create_overage_invoice(customer_id: str, amount_usd: float) -> dict:
    return billing.create_overage_invoice(
        customer_id, amount_usd, memo="Issued by the MeterPal merchant agent"
    )


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_low_balance_customers",
            "description": "List MeterPal customers whose AI credit balance is below a threshold",
            "parameters": {
                "type": "object",
                "properties": {
                    "below_credits": {"type": "number", "description": "Threshold, default 0.5"}
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_customer_usage",
            "description": "AI usage for a customer over N days: credits spent and per-model breakdown",
            "parameters": {
                "type": "object",
                "properties": {
                    "customer_id": {"type": "string"},
                    "days": {"type": "integer"},
                },
                "required": ["customer_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_overage_invoice",
            "description": "Create and send a PayPal invoice for AI usage overage; payment credits the wallet via webhook",
            "parameters": {
                "type": "object",
                "properties": {
                    "customer_id": {"type": "string"},
                    "amount_usd": {"type": "number"},
                },
                "required": ["customer_id", "amount_usd"],
            },
        },
    },
]


def execute(name: str, args: dict) -> dict:
    if name == "list_low_balance_customers":
        return tool_list_low_balance_customers(**args)
    if name == "get_customer_usage":
        return tool_get_customer_usage(**args)
    if name == "create_overage_invoice":
        return tool_create_overage_invoice(**args)
    raise ValueError(f"unknown tool {name}")


def banner(text: str) -> None:
    print(f"\n\033[36m▶ {text}\033[0m")


def show(result: dict) -> None:
    print(json.dumps(result, indent=2, default=str))


# --------------------------------------------------------------------------
# Scripted run — the exact sequence an LLM would choose, no key required
# --------------------------------------------------------------------------


def run_scripted() -> None:
    print("MeterPal merchant agent (scripted mode — same tool calls an LLM makes)\n")

    banner("Tool: list_low_balance_customers(below_credits=0.5)")
    low = execute("list_low_balance_customers", {"below_credits": 0.5})
    show(low)
    if not low["customers"]:
        print("\nNo low-balance customers. Drain a wallet first (python demo/run_demo.py).")
        return

    target = low["customers"][0]
    who = target["customer_id"]

    banner(f"Tool: get_customer_usage(customer_id={who!r}, days=30)")
    usage = execute("get_customer_usage", {"customer_id": who})
    show(usage)

    amount = max(1.0, round(abs(usage["credits_spent"]) + 1.0, 2))
    banner(f"Tool: create_overage_invoice(customer_id={who!r}, amount_usd={amount})")
    try:
        invoice = execute("create_overage_invoice", {"customer_id": who, "amount_usd": amount})
        show(invoice)
        print(
            "\n✅ Invoice sent via PayPal Invoicing. When the buyer pays it, the "
            "INVOICING.INVOICE.PAID webhook credits their wallet automatically."
        )
    except MeterPalError as exc:
        print(f"\n⚠️  Invoice step failed ({exc}). With PayPal sandbox keys set, this "
              "sends a real sandbox invoice email to the buyer account.")


# --------------------------------------------------------------------------
# LLM run — OpenAI-compatible function calling
# --------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are the merchant agent for MeterPal, an AI usage-billing platform. "
    "Manage the merchant's AI billing workflow: find customers running low on "
    "AI credits, summarize their usage, and issue PayPal overage invoices. "
    "1 credit = 1 USD of model cost. Always show your tool results."
)


def run_llm() -> None:
    try:
        from openai import OpenAI
    except ImportError:
        sys.exit("LLM mode needs the openai package: pip install openai")

    client = OpenAI()  # OPENAI_API_KEY (+ optional OPENAI_BASE_URL)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                "Find customers running low on AI credits, show the top one's "
                "usage by model, and issue them a PayPal overage invoice sized "
                "to their last-30-day spend plus a dollar of headroom."
            ),
        },
    ]

    for _ in range(8):
        resp = client.chat.completions.create(
            model=os.environ.get("METERPAL_AGENT_MODEL", "gpt-4o-mini"),
            messages=messages,  # type: ignore[arg-type]
            tools=TOOLS,  # type: ignore[arg-type]
        )
        msg = resp.choices[0].message
        if msg.content:
            print(f"\n\033[33magent:\033[0m {msg.content}")
        if not msg.tool_calls:
            return
        messages.append(msg)  # type: ignore[arg-type]
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            banner(f"Tool: {call.function.name}({json.dumps(args)})")
            try:
                result = execute(call.function.name, args)
            except Exception as exc:  # surface tool errors to the model
                result = {"error": str(exc)}
            show(result)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(result, default=str),
                }
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--llm", action="store_true", help="drive tools via an OpenAI-compatible model")
    args = parser.parse_args()
    run_llm() if args.llm else run_scripted()
