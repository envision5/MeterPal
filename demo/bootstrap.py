"""
demo/bootstrap.py -- one-time seed for the local demo.

Because a fresh Autumn database has no organization and therefore no secret
key (api_keys rows belong to an org), this script bootstraps one directly:

  1. psql: insert org "demo" + a sandbox secret key (hashed with SHA-256,
     the same scheme as server/src/internal/dev/apiKeys/apiKeyUtils.ts).
  2. Autumn API: create the "ai_tokens" AI-credit-system feature with
     model_markups pricing custom/demo-gpt at $20/M input, $80/M output.
  3. Autumn API: create customer "demo-customer" and grant 2.00 credits.

Idempotent: safe to re-run; every step resets to the same state.

Run:  python demo/bootstrap.py
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "gateway"))

AUTUMN = "http://localhost:8080"
PG_CONTAINER = "meterpal-postgres-billing"
PG_USER, PG_DB = "autumn", "autumn"

ORG_ID, ORG_SLUG = "org_demo", "demo"
KEY_ID = "key_demo_bridge"
# Demo secret key.  LOCAL ONLY -- production keys come from the dashboard.
AUTUMN_SECRET_KEY = "am_sk_test_JvWnILAeT5zTxPfHTPvJKV6NNDTn8uF97Np38YRe6d"

FEATURE_ID = "ai_tokens"
CUSTOMER_ID = "demo-customer"
STARTING_BALANCE = 2.0

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
    """Retry transient 502/503s (Autumn sheds requests until Redis warms up)."""
    for attempt in range(1, tries + 1):
        resp = c.request(method, path, **kw)
        if resp.status_code not in (502, 503) or attempt == tries:
            return resp
        print(f"  {resp.status_code} on {method} {path} -- Autumn warming up, retry {attempt}/{tries}")
        time.sleep(2)
    return resp


def main() -> None:
    hashed = hashlib.sha256(AUTUMN_SECRET_KEY.encode()).hexdigest()

    step("1. Bootstrap org + secret key (psql)")
    r = psql(f"""
        INSERT INTO organizations (id, slug, name, "createdAt", created_at, config, is_sandbox, onboarded)
        VALUES ('{ORG_ID}', '{ORG_SLUG}', 'Demo Org', NOW(), {int(time.time() * 1000)}, '{{}}'::jsonb, true, true)
        ON CONFLICT (slug) DO NOTHING;
        INSERT INTO api_keys (id, name, prefix, org_id, env, hashed_key, scopes)
        VALUES ('{KEY_ID}', 'Demo bridge key', 'am_sk_test', '{ORG_ID}', 'sandbox', '{hashed}', NULL)
        ON CONFLICT DO NOTHING;
    """)
    if r.returncode != 0:
        print(r.stdout, r.stderr, sep="\n")
        sys.exit("  psql failed -- is docker compose up?")
    ok(f"org '{ORG_SLUG}' + sandbox secret key present (sha256 stored, key never logged)")

    step("2. Create ai_tokens feature (AI credit system)")
    with httpx.Client(base_url=AUTUMN, headers={"Authorization": f"Bearer {AUTUMN_SECRET_KEY}"}, timeout=15) as c:
        if c.get(f"/v1/features/{FEATURE_ID}").status_code == 200:
            ok(f"feature '{FEATURE_ID}' already exists -- leaving as-is")
        else:
            body = {
                "id": FEATURE_ID,
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
                },
            }
            resp = api_call(c, "POST", "/v1/features", json=body)
            if resp.status_code >= 300:
                sys.exit(f"  feature create failed: {resp.status_code} {resp.text[:400]}")
            ok(f"feature '{FEATURE_ID}' (1 credit = $1 of model cost; custom/demo-gpt at "
               f"${DEMO_RATES['input_cost']}/M in, ${DEMO_RATES['output_cost']}/M out)")

        step("3. Create free plan granting credits (auto-attaches on signup -- "
             "the role a Stripe subscription plays in production)")
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
                "create_in_stripe": False,
                "items": [{
                    "feature_id": FEATURE_ID,
                    "included": STARTING_BALANCE,
                    "reset": {"interval": "month"},
                }],
            })
            if resp.status_code >= 300:
                sys.exit(f"  plan create failed: {resp.status_code} {resp.text[:400]}")
            ok(f"plan 'demo-starter': {STARTING_BALANCE:.2f} credits/month, free")

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
