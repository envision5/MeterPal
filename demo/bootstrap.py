"""
demo/bootstrap.py -- one-time seed for the local demo.

Because a fresh MeterPal database has no organization and therefore no secret
key (api_keys rows belong to an org), this script bootstraps one directly:

  1. psql: insert org "demo" + a sandbox secret key (hashed with SHA-256,
     the same scheme as server/src/internal/dev/apiKeys/apiKeyUtils.ts).
  2. MeterPal API: create the "ai_tokens" AI-credit-system feature with
     model_markups pricing custom/demo-gpt at $20/M input, $80/M output.
  3. MeterPal API: create customer "demo-customer" and grant 2.00 credits.

Idempotent: safe to re-run; every step resets to the same state.

Run:  python demo/bootstrap.py
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "gateway"))

BASE_URL = "http://localhost:8080"
PG_CONTAINER = "meterpal-postgres-billing"
# Matches docker-compose.yml (POSTGRES_USER/POSTGRES_DB on the billing
# instance) and billing/server/.env.example.
PG_USER, PG_DB = "autumn", "autumn"

PAYPAL_EVENTS = [
    "BILLING.SUBSCRIPTION.ACTIVATED",
    "BILLING.SUBSCRIPTION.CANCELLED",
    "BILLING.SUBSCRIPTION.SUSPENDED",
    "BILLING.SUBSCRIPTION.EXPIRED",
    "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
    "PAYMENT.SALE.COMPLETED",
    "PAYMENT.CAPTURE.COMPLETED",
    "PAYMENT.CAPTURE.REFUNDED",
    "CHECKOUT.ORDER.APPROVED",
    "INVOICING.INVOICE.PAID",
]


def register_paypal_webhook() -> None:
    """Create the PayPal webhook subscription pointing at PAYPAL_WEBHOOK_URL.

    Avoids dashboard clicking during local sandbox testing.  Idempotent:
    reuses an existing webhook pointed at the same URL.
    """
    base = (
        "https://api-m.paypal.com"
        if os.environ.get("PAYPAL_ENV") == "live"
        else "https://api-m.sandbox.paypal.com"
    )
    auth = (os.environ["PAYPAL_CLIENT_ID"], os.environ["PAYPAL_CLIENT_SECRET"])
    url = os.environ["PAYPAL_WEBHOOK_URL"]
    with httpx.Client(base_url=base, auth=auth, timeout=20) as c:
        token = c.post(
            "/v1/oauth2/token",
            data={"grant_type": "client_credentials"},
        ).json()["access_token"]
        c.headers["Authorization"] = f"Bearer {token}"
        existing = c.get("/v1/notifications/webhooks").json().get("webhooks", [])
        match = next((w for w in existing if w.get("url") == url), None)
        if match:
            ok(f"webhook already registered -> {url} (id {match['id']})")
            print(f"  set PAYPAL_WEBHOOK_ID={match['id']} in billing/server/.env")
            return
        resp = c.post(
            "/v1/notifications/webhooks",
            json={"url": url, "event_types": [{"name": n} for n in PAYPAL_EVENTS]},
        )
        if resp.status_code >= 300:
            print(f"  ! webhook registration failed: {resp.status_code} {resp.text[:300]}")
            return
        webhook_id = resp.json()["id"]
        ok(f"webhook registered -> {url} (id {webhook_id})")
        print(f"  set PAYPAL_WEBHOOK_ID={webhook_id} in billing/server/.env")

ORG_ID, ORG_SLUG = "org_demo", "demo"
KEY_ID = "key_demo_bridge"
# Demo secret key.  LOCAL ONLY -- production keys come from the dashboard.
METERPAL_SECRET_KEY = "am_sk_test_JvWnILAeT5zTxPfHTPvJKV6NNDTn8uF97Np38YRe6d"

FEATURE_ID = "ai_tokens"
CUSTOMER_ID = "demo-customer"
# Sized so the walkthrough's phases land: phases 2-3 spend ~0.92, phase 4's
# drain loop crosses the reservation hold (~0.82) mid-loop and the NEXT call
# is refused with 402.
STARTING_BALANCE = 3.0

# $/M tokens for custom/demo-gpt: billed straight from these numbers, since
# custom/ models skip models.dev entirely (see aiCreditSystemUtils.ts).
DEMO_RATES = {"input_cost": 20, "output_cost": 80}


def psql(sql: str) -> str:
    return subprocess.run(
        ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True,
    )


def step(title: str) -> None:
    print(f"\n\033[1;36m== {title} ==\033[0m")


def ok(msg: str) -> None:
    print(f"  \033[32m✓\033[0m {msg}")


def api_call(c: httpx.Client, method: str, path: str, tries: int = 6, **kw) -> httpx.Response:
    """Retry transient 502/503s (MeterPal sheds requests until Redis warms up)."""
    for attempt in range(1, tries + 1):
        resp = c.request(method, path, **kw)
        if resp.status_code not in (502, 503) or attempt == tries:
            return resp
        print(f"  {resp.status_code} on {method} {path} -- MeterPal warming up, retry {attempt}/{tries}")
        time.sleep(2)
    return resp


def main() -> None:
    hashed = hashlib.sha256(METERPAL_SECRET_KEY.encode()).hexdigest()

    step("1. Bootstrap org + secret key (psql)")
    r = psql(f"""
        INSERT INTO organizations (id, slug, name, "createdAt", created_at, config, is_sandbox, onboarded)
        VALUES ('{ORG_ID}', '{ORG_SLUG}', 'Demo Org', NOW(), {int(time.time() * 1000)}, '{{}}'::jsonb, false, true)
        ON CONFLICT (slug) DO NOTHING;
        -- The demo org is the merchant's OWN org, not a sandbox sub-org: is_sandbox
        -- marks a sub-org of a master. The demo runs in the sandbox *env* through
        -- its key below. Older seeds set is_sandbox = true, which made the
        -- dashboard refuse /v1/sandboxes.list with a 400 ("sandboxes are managed
        -- from your main organization"). Repair it on every bootstrap.
        UPDATE organizations SET is_sandbox = false WHERE id = '{ORG_ID}';
        INSERT INTO api_keys (id, name, prefix, org_id, env, hashed_key, scopes)
        VALUES ('{KEY_ID}', 'Demo bridge key', 'am_sk_test', '{ORG_ID}', 'sandbox', '{hashed}', NULL)
        ON CONFLICT DO NOTHING;
    """)
    if r.returncode != 0:
        print(r.stdout, r.stderr, sep="\n")
        sys.exit("  psql failed -- is docker compose up?")
    ok(f"org '{ORG_SLUG}' + sandbox secret key present (sha256 stored, key never logged)")

    step("2. Create ai_tokens feature (AI credit system)")
    with httpx.Client(base_url=BASE_URL, headers={"Authorization": f"Bearer {METERPAL_SECRET_KEY}"}, timeout=15) as c:
        feature_body = {
            "id": FEATURE_ID,
            "feature_id": FEATURE_ID,
            "name": "AI Tokens",
            "type": "ai_credit_system",
            "consumable": True,
            "display": {"singular": "credit", "plural": "credits"},
            "default_markup": 0,
            "model_markups": {
                "custom/demo-gpt": {
                    "markup": 0,
                    "input_cost": DEMO_RATES["input_cost"],
                    "output_cost": DEMO_RATES["output_cost"],
                },
                # Agnes AI (real model, free trial tier) — same demo rates
                # so the wallet visibly drains. Real list prices are
                # $0.05/M in, $0.15/M out.
                "custom/agnes-2.5-flash": {
                    "markup": 0,
                    "input_cost": DEMO_RATES["input_cost"],
                    "output_cost": DEMO_RATES["output_cost"],
                },
            },
        }
        if c.get(f"/v1/features/{FEATURE_ID}").status_code == 200:
            # Reset the demo rates on every run so the walkthrough's printed
            # expected-cost lines always match the live price sheet, even if
            # the dashboard was used to experiment between runs.
            resp = api_call(c, "POST", "/v1/features.update", json=feature_body)
            if resp.status_code >= 300:
                sys.exit(f"  feature update failed: {resp.status_code} {resp.text[:400]}")
            ok(f"feature '{FEATURE_ID}' rates reset to "
               f"${DEMO_RATES['input_cost']}/M in, ${DEMO_RATES['output_cost']}/M out")
        else:
            resp = api_call(c, "POST", "/v1/features", json=feature_body)
            if resp.status_code >= 300:
                sys.exit(f"  feature create failed: {resp.status_code} {resp.text[:400]}")
            ok(f"feature '{FEATURE_ID}' (1 credit = $1 of model cost; custom/demo-gpt at "
               f"${DEMO_RATES['input_cost']}/M in, ${DEMO_RATES['output_cost']}/M out)")

        step("2b. Reset the served-model price sheet (the org's own prices -- "
             "they WIN over the feature markups, so the walkthrough's printed "
             "expected-costs stay truthful even after dashboard edits)")
        for sheet in [
            # model_id, display name, input $/1M, output $/1M
            ("custom/demo-gpt", "Demo GPT (mock)", DEMO_RATES["input_cost"], DEMO_RATES["output_cost"]),
            # gpt-4o-mini at true models.dev list rates for phase 3.
            ("openai/gpt-4o-mini", "GPT-4o mini (mock)", 0.15, 0.60),
            # Agnes AI — the real model the sales agent's own brain runs on.
            # MeterPal meters its own agents: every negotiation turn costs the
            # agent-sales wallet (see step 4c below).
            ("custom/agnes-2.5-flash", "Agnes 2.5 Flash (real)", DEMO_RATES["input_cost"], DEMO_RATES["output_cost"]),
        ]:
            model_id, display, cin, cout = sheet
            resp = api_call(c, "POST", "/v1/served_models", json={
                "model_id": model_id,
                "display_name": display,
                "enabled": True,
                "input_cost_usd_1m": cin,
                "output_cost_usd_1m": cout,
                "markup_pct": 0,
            })
            if resp.status_code >= 300:
                sys.exit(f"  served-model upsert failed for {model_id}: "
                         f"{resp.status_code} {resp.text[:300]}")
            ok(f"price sheet: {model_id} at ${cin}/M in, ${cout}/M out")

        step("3. Create free plan granting credits (auto-attaches on signup -- "
             "the role a subscription plays in production)")
        if c.get("/v1/plans/demo-starter").status_code == 200:
            resp = api_call(c, "POST", "/v1/plans/demo-starter", json={
                "auto_enable": True,
                "items": [{
                    "feature_id": FEATURE_ID,
                    "included": STARTING_BALANCE,
                    "reset": {"interval": "month"},
                }],
            })
            if resp.status_code >= 300:
                sys.exit(f"  plan update failed: {resp.status_code} {resp.text[:400]}")
            ok("plan 'demo-starter' updated (auto_enable=true, free)")
        else:
            resp = api_call(c, "POST", "/v1/plans", json={
                "id": "demo-starter",
                "name": "Demo Starter",
                "auto_enable": True,

                "items": [{
                    "feature_id": FEATURE_ID,
                    "included": STARTING_BALANCE,
                    "reset": {"interval": "month"},
                }],
            })
            if resp.status_code >= 300:
                sys.exit(f"  plan create failed: {resp.status_code} {resp.text[:400]}")
            ok(f"plan 'demo-starter': {STARTING_BALANCE:.2f} credits/month, free")

        step("3b. Create paid plan + credit packs (PayPal checkout catalog)")
        if c.get("/v1/plans/pro").status_code != 200:
            resp = api_call(c, "POST", "/v1/plans", json={
                "id": "pro",
                "name": "MeterPal Pro",

                "items": [{
                    "feature_id": FEATURE_ID,
                    "included": 100,
                    "reset": {"interval": "month"},
                    "price": {
                        "amount": 20,
                        "interval": "month",
                        "billing_method": "prepaid",
                    },
                }],
            })
            if resp.status_code >= 300:
                print(f"  ! pro plan create failed: {resp.status_code} {resp.text[:300]}")
            else:
                ok("plan 'pro': 100 credits/month at $20 (PayPal subscription on checkout)")
        else:
            ok("plan 'pro' already exists")

        for pack_id, credits, price in [
            ("topup_10", 10, 10),
            ("topup_50", 50, 50),
            ("topup_200", 200, 200),
        ]:
            if c.get(f"/v1/plans/{pack_id}").status_code == 200:
                ok(f"credit pack '{pack_id}' already exists")
                continue
            resp = api_call(c, "POST", "/v1/plans", json={
                "id": pack_id,
                "name": f"{credits:,} credits",
                "add_on": True,

                "items": [{
                    "feature_id": FEATURE_ID,
                    "included": credits,
                    "price": {
                        "amount": price,
                        "interval": "one_off",
                        "billing_method": "prepaid",
                    },
                }],
            })
            if resp.status_code >= 300:
                print(f"  ! credit pack '{pack_id}' create failed: {resp.status_code} {resp.text[:300]}")
            else:
                ok(f"credit pack '{pack_id}': {credits} credits for ${price} (PayPal order on checkout)")

        step("4. Create demo customer (plan auto-attaches, granting credits)")
        resp = api_call(c, "DELETE", f"/v1/customers/{CUSTOMER_ID}")
        resp = api_call(c, "POST", "/v1/customers", json={
            "id": CUSTOMER_ID,
            "name": "Ada Lovelace",
            "email": "ada@example.com",
        })
        if resp.status_code >= 300:
            sys.exit(f"  customer create failed: {resp.status_code} {resp.text[:400]}")
        ok(f"customer '{CUSTOMER_ID}' created and auto-attached to 'demo-starter'")

        step("4b. Create a second customer (for the demo-app switcher + agent demos)")
        resp = api_call(c, "DELETE", "/v1/customers/demo-customer-2")
        resp = api_call(c, "POST", "/v1/customers", json={
            "id": "demo-customer-2",
            "name": "Grace Hopper",
            "email": "grace@example.com",
        })
        if resp.status_code >= 300:
            print(f"  ! customer-2 create failed: {resp.status_code} {resp.text[:300]}")
        else:
            ok("customer 'demo-customer-2' created (auto-attached to 'demo-starter')")

        step("4b2. Create the sales agent's own wallet (its brain is metered too)")
        resp = api_call(c, "DELETE", "/v1/customers/agent-sales")
        resp = api_call(c, "POST", "/v1/customers", json={
            "id": "agent-sales",
            "name": "MeterPal Sales Agent",
            "email": "sales-agent@example.com",
        })
        if resp.status_code >= 300:
            print(f"  ! agent-sales create failed: {resp.status_code} {resp.text[:300]}")
        else:
            ok("customer 'agent-sales' created (auto-attached to 'demo-starter'; "
               "engine.ts AGENT_CUSTOMER_ID bills every negotiation turn here)")

        step("4c. Register the PayPal webhook (sandbox) if keys are configured")
        if os.environ.get("PAYPAL_CLIENT_ID") and os.environ.get("PAYPAL_WEBHOOK_URL"):
            register_paypal_webhook()
        else:
            ok("skipped (set PAYPAL_CLIENT_ID + PAYPAL_WEBHOOK_URL to auto-register)")

        step("5. Verify admission check")
        resp = api_call(c, "POST", "/v1/check", json={
            "customer_id": CUSTOMER_ID,
            "feature_id": FEATURE_ID,
            "required_balance": 0.5,
        })
        print(f"  /check -> {resp.status_code} {json.dumps(resp.json(), indent=2)[:300]}")
        if resp.status_code >= 300 or not resp.json().get("allowed"):
            sys.exit("  /check did not allow the seeded customer")

    print("\n\033[1;32mBootstrap complete. Run:  python demo/run_demo.py\033[0m")


if __name__ == "__main__":
    main()
