"""
demo/run_demo.py -- guided walkthrough of the LiteLLM + MeterPal billing loop.

Requires the stack from demo/README.md to be running.  It walks through:

  1. The customer's starting balance
  2. Chat calls through LiteLLM (mock provider) and the balance dropping
     after each call, including a cached-input call billed at cheaper rates
  3. A second model priced from models.dev list rates (no config needed)
  4. Draining the wallet until MeterPal's /check refuses the NEXT call (402)
     -- admission control, before any provider is touched
  5. A top-up (the API call a Stripe/PayPal webhook will make in prod)
     and the same customer being admitted again
  6. The usage ledger in Postgres: per-call cost, rates, markup, tokens

Run:  python demo/run_demo.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent

LITELLM = "http://localhost:4000"
AUTUMN = "http://localhost:8080"
PG_CONTAINER = "meterpal-postgres-billing"
PG_USER, PG_DB = "autumn", "autumn"

FEATURE_ID = "ai_tokens"
CUSTOMER_ID = "demo-customer"
REQUIRED_BALANCE = 0.5  # keep in sync with AUTUMN_REQUIRED_BALANCE in litellm/.env

# Rates configured in demo/bootstrap.py for custom/demo-gpt ($/M tokens).
DEMO_IN, DEMO_OUT = 20.0, 80.0


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            env[k.strip()] = v
    return env


ENV = load_env(ROOT / "gateway" / ".env")
MASTER_KEY = ENV.get("LITELLM_MASTER_KEY", "")
AUTUMN_KEY = ENV.get("PAB_API_KEY") or ENV.get("AUTUMN_API_KEY", "")

C = "\033[0m"
B, CY, GR, YE, RD, DI = "\033[1m", "\033[1;36m", "\033[32m", "\033[33m", "\033[31m", "\033[2m"


def phase(n: int, title: str) -> None:
    print(f"\n{B}{CY}{'─' * 62}\n  PHASE {n} · {title}\n{'─' * 62}{C}")


def balance(client: httpx.Client) -> float | None:
    resp = client.get(f"/v1/customers/{CUSTOMER_ID}", params={"expand": "balances.feature"})
    if resp.status_code != 200:
        return None
    data = resp.json()
    balances = data.get("balances") or {}
    bal = balances.get(FEATURE_ID) or {}
    v = bal.get("balance", bal.get("remaining"))
    return float(v) if v is not None else None


def show_balance(client: httpx.Client) -> None:
    v = balance(client)
    print(f"  {B}balance: {v:.6f} credits{C}" if v is not None else f"  {RD}balance unavailable{C}")


def chat(client: httpx.Client, model: str, prompt: str, label: str) -> dict | None:
    """One completion through LiteLLM; prints the round trip. Returns the JSON."""
    resp = client.post(
        "/v1/chat/completions",
        json={"model": model, "user": CUSTOMER_ID, "messages": [{"role": "user", "content": prompt}]},
    )
    if resp.status_code == 402:
        detail = resp.json().get("error", {}).get("detail", resp.json())
        print(f"  {RD}✗ {label}: HTTP 402 -- ADMISSION DENIED{C}")
        print(f"    {DI}{json.dumps(detail, indent=None)[:160]}{C}")
        return None
    if resp.status_code != 200:
        print(f"  {RD}✗ {label}: HTTP {resp.status_code}{C} {resp.text[:200]}")
        return None
    data = resp.json()
    usage = data.get("usage", {})
    content = data["choices"][0]["message"]["content"]
    print(f"  {GR}✓{C} {label} {DI}({model}){C}")
    print(f"    reply   : {content[:100]}")
    print(f"    usage   : {usage.get('prompt_tokens')} prompt "
          f"({usage.get('prompt_tokens_details', {}).get('cached_tokens', 0)} cached) "
          f"/ {usage.get('completion_tokens')} completion")
    time.sleep(1.5)  # let MeterPal's deduction + customer cache settle before the balance read
    return data


def ledger(limit: int = 8) -> None:
    sql = (
        "SELECT to_char(timestamp, 'MM-DD HH24:MI:SS') AS at, "
        "properties->>'model' AS model, "
        "properties->>'status' AS status, "
        "properties->>'input_tokens' AS in_tok, "
        "properties->>'output_tokens' AS out_tok, "
        "properties->>'cache_read_tokens' AS cached, "
        "round((properties->>'base_cost')::numeric, 6) AS base_usd, "
        "round((properties->>'cost')::numeric, 6) AS credits, "
        "properties->>'markup_source' AS markup "
        f"FROM events WHERE customer_id = '{CUSTOMER_ID}' "
        f"ORDER BY timestamp DESC LIMIT {limit};"
    )
    r = subprocess.run(
        ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-c", sql],
        capture_output=True, text=True,
    )
    print(r.stdout if r.returncode == 0 else r.stderr)


def main() -> None:
    litellm_c = httpx.Client(base_url=LITELLM, headers={"Authorization": f"Bearer {MASTER_KEY}"}, timeout=60)
    autumn_c = httpx.Client(base_url=AUTUMN, headers={"Authorization": f"Bearer {AUTUMN_KEY}"}, timeout=30)

    # Preflight
    print(f"{B}AI billing demo -- LiteLLM :4000  →  MeterPal :8080  →  mock LLM :9999{C}")
    for name, url in [("mock LLM", "http://localhost:9999/healthz"),
                      ("MeterPal", f"{AUTUMN}/health"),
                      ("LiteLLM", f"{LITELLM}/health/liveliness")]:
        try:
            httpx.get(url, timeout=5)
            print(f"  {GR}✓ {name} up{C}")
        except Exception:
            print(f"  {RD}✗ {name} NOT reachable at {url} -- see demo/README.md{C}")
            sys.exit(1)

    phase(1, "Starting state")
    show_balance(autumn_c)

    phase(2, "Chat calls bill the wallet (custom/demo-gpt: $20/M in, $80/M out)")
    chat(litellm_c, "demo-gpt", "hello there [usage: in=10000 out=2000]", "call 1 (10,000 in / 2,000 out)")
    print(f"    {DI}expected cost: 10000×20/1M + 2000×80/1M = $0.36{C}")
    show_balance(autumn_c)

    chat(litellm_c, "demo-gpt", "and again [usage: in=10000 out=2000]", "call 2 (same size)")
    show_balance(autumn_c)

    chat(litellm_c, "demo-gpt",
         "cache me [usage: in=2000 out=2000 cache_read=8000]",
         "call 3 (8,000 of 10,000 input CACHED)")
    print(f"    {DI}custom models bill cache at $0 -- only 2,000 fresh input is charged: $0.20{C}")
    show_balance(autumn_c)

    phase(3, "A second model priced from models.dev (gpt-4o-mini list rates)")
    chat(litellm_c, "gpt-4o-mini-mock", "price me from models.dev [usage: in=5000 out=1000]", "call 4")
    print(f"    {DI}expected cost: 5000×0.15/1M + 1000×0.60/1M = $0.00135 (list rates){C}")
    show_balance(autumn_c)

    phase(4, "Drain the wallet -> admission control cuts off the NEXT call")
    for i in range(5, 12):
        r = chat(litellm_c, "demo-gpt", f"drain {i} [usage: in=10000 out=2000]", f"call {i}")
        if r is None:
            break
        show_balance(autumn_c)
        time.sleep(1.2)  # let the bridge's /check cache expire
    show_balance(autumn_c)

    phase(5, "Top-up (what a Stripe/PayPal webhook triggers in production)")
    # The balances endpoint takes an ABSOLUTE value: raising it grants
    # credits; lowering it would be recorded as consumption.
    resp = autumn_c.post(f"/v1/customers/{CUSTOMER_ID}/balances",
                         json={"balances": [{"feature_id": FEATURE_ID, "balance": 2.0}]})
    print(f"  POST /v1/customers/{CUSTOMER_ID}/balances (balance -> 2.0) -> {resp.status_code}")
    time.sleep(1.2)
    show_balance(autumn_c)
    chat(litellm_c, "demo-gpt", "back in business [usage: in=1000 out=200]", "call after top-up: admitted again")
    show_balance(autumn_c)

    phase(6, "Usage ledger (events table in MeterPal's Postgres)")
    time.sleep(1.5)  # event batches flush every 350ms in the background
    ledger()

    print(f"\n{B}Demo complete.{C} Every call above was metered and debited by MeterPal,")
    print("and when the wallet ran dry, admission was refused BEFORE hitting the provider.")
    print(f"{DI}The status=failure row with 0 tokens is the 402-denied call -- recorded")
    print(f"by the bridge's failure hook, billed at 0.{C}")
    print("What you did NOT see: Stripe/PayPal webhooks driving these balances --")
    print("that is the only part to swap in when you wire real keys.")


if __name__ == "__main__":
    main()
