"""
demo/bootstrap.py -- one-time seed for the local demo.

Because a fresh MeterPal database has no organization and therefore no secret
key (api_keys rows belong to an org), this script bootstraps one directly:

  1. psql: insert the org + a sandbox secret key minted fresh per run
     (hashed with SHA-256, the same scheme as
     server/src/internal/dev/apiKeys/apiKeyUtils.ts).
  2. MeterPal API: create the "ai_tokens" AI-credit-system feature with
     model_markups pricing custom/demo-gpt at $20/M input, $80/M output.
  3. MeterPal API: create the demo customers and grant credits.
  4. MeterPal API: create the starter catalog (free plan, paid plan, top-ups).
  5. Bind the stack to this org (demo/bind.py): writes the key into
     gateway/.env + billing/server/.env, and the demo app's binding into
     demo-app/.env.local + demo-app/.binding.json.

Pass --admin you@example.com and the first dashboard sign-in claims this org
as its owner instead of getting an empty one of its own -- so the merchant you
set up here is, by construction, the merchant the demo app bills.

Idempotent: safe to re-run; every step resets to the same state.

Run:  python demo/bootstrap.py --admin you@example.com
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
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

    The settings are read from billing/server/.env as well as the shell --
    the dashboard writes them there, and a shell-only read meant the values
    were never found and the step was silently skipped even after PayPal was
    connected.

    The id is written back to that file rather than printed for the operator
    to paste: an unset PAYPAL_WEBHOOK_ID is exactly the state that made a
    "webhook credits the wallet" claim untrue while the credits still landed
    through the demo app's capture poll.
    """
    base = (
        "https://api-m.paypal.com"
        if env_value("PAYPAL_ENV") == "live"
        else "https://api-m.sandbox.paypal.com"
    )
    client_id = env_value("PAYPAL_CLIENT_ID")
    client_secret = env_value("PAYPAL_CLIENT_SECRET")
    url = env_value("PAYPAL_WEBHOOK_URL")
    if not (client_id and client_secret and url):
        missing = [
            name
            for name, value in [
                ("PAYPAL_CLIENT_ID", client_id),
                ("PAYPAL_CLIENT_SECRET", client_secret),
                ("PAYPAL_WEBHOOK_URL", url),
            ]
            if not value
        ]
        print(f"  ! webhook not registered: {', '.join(missing)} unset")
        print("    PayPal cannot reach http://localhost:8080. Either expose the")
        print("    billing server (a tunnel) and set PAYPAL_WEBHOOK_URL to it, or")
        print("    leave this unset and describe the money beat honestly: the demo")
        print("    app captures approved orders on a poll, not on a webhook.")
        return

    with httpx.Client(base_url=base, auth=(client_id, client_secret), timeout=20) as c:
        token = c.post(
            "/v1/oauth2/token",
            data={"grant_type": "client_credentials"},
        ).json()["access_token"]
        c.headers["Authorization"] = f"Bearer {token}"
        existing = c.get("/v1/notifications/webhooks").json().get("webhooks", [])
        match = next((w for w in existing if w.get("url") == url), None)
        if match:
            replace_env_value(BILLING_ENV, "PAYPAL_WEBHOOK_ID", match["id"])
            ok(f"webhook already registered -> {url} (id {match['id']})")
            return
        resp = c.post(
            "/v1/notifications/webhooks",
            json={"url": url, "event_types": [{"name": n} for n in PAYPAL_EVENTS]},
        )
        if resp.status_code >= 300:
            print(f"  ! webhook registration failed: {resp.status_code} {resp.text[:300]}")
            return
        webhook_id = resp.json()["id"]
        replace_env_value(BILLING_ENV, "PAYPAL_WEBHOOK_ID", webhook_id)
        ok(f"webhook registered -> {url} (id {webhook_id})")

ORG_ID, ORG_SLUG, ORG_NAME = "org_demo", "demo", "Demo Org"
KEY_ID = "key_demo_bridge"
# Demo secret key.  Minted fresh on every bootstrap run -- NEVER committed to
# the repo -- and written to gateway/.env (PAB_API_KEY), the single source the
# gateway, the demo app and run_demo.py all read.  Production keys come from
# the dashboard.
METERPAL_SECRET_KEY = "am_sk_test_" + secrets.token_hex(21)

GATEWAY_ENV = ROOT / "gateway" / ".env"
# The dashboard (billing/vite) authenticates against this same server with
# AUTUMN_SECRET_KEY, so it has to follow the key too -- otherwise the freshly
# minted key leaves the dashboard calling its own API with a dead key (401 on
# /api/autumn/*).  Same line-replace treatment as gateway/.env.
BILLING_ENV = ROOT / "billing" / "server" / ".env"


def replace_env_value(path: Path, name: str, value: str) -> None:
    """Point `path`'s `name=` line at `value` (idempotent).

    Preserves the file's own line endings: these .env files are CRLF on Windows,
    and writing a bare \\n there makes dotenv hand the server `value\\r`, which
    fails every exact-match comparison in silence.
    """
    if not path.exists():
        sys.exit(f"  {path} not found -- copy the .env template first")
    raw = path.read_text(encoding="utf-8")
    nl = "\r\n" if "\r\n" in raw else "\n"
    lines = raw.splitlines()
    out, replaced = [], False
    for line in lines:
        if re.match(rf"^{name}=", line):
            out.append(f"{name}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"{name}={value}")
    path.write_text(nl.join(out) + nl, encoding="utf-8")


def replace_env_key(path: Path, name: str) -> None:
    """Point `path`'s `name=` line at the freshly minted key (idempotent)."""
    replace_env_value(path, name, METERPAL_SECRET_KEY)


def env_value(name: str) -> str | None:
    """A setting from the shell, else from billing/server/.env.

    The dashboard writes PayPal credentials into that file, so a shell-only
    read misses everything the merchant configured through the UI.
    """
    from_shell = os.environ.get(name)
    if from_shell:
        return from_shell
    try:
        for line in BILLING_ENV.read_text(encoding="utf-8").splitlines():
            match = re.match(rf"^{name}=(.*)$", line)
            if match:
                value = match.group(1).strip().strip('"').strip("'")
                return value or None
    except OSError:
        pass
    return None


def write_gateway_env_key() -> None:
    """Point gateway/.env at the freshly minted key (idempotent line replace)."""
    replace_env_key(GATEWAY_ENV, "PAB_API_KEY")
    replace_env_key(BILLING_ENV, "AUTUMN_SECRET_KEY")


def write_first_run_claim(email: str) -> None:
    """Name the org the first dashboard sign-in should claim as owner.

    Read by createDefaultOrg.ts on session creation: if the org still has no
    members and the signing-in email matches, that user becomes its owner
    instead of getting an empty org of their own. Unset in production.
    """
    replace_env_value(BILLING_ENV, "METERPAL_FIRST_RUN_ORG", ORG_ID)
    replace_env_value(BILLING_ENV, "METERPAL_FIRST_RUN_EMAIL", email)
    ok(f"first sign-in with {email} will claim '{ORG_ID}' as owner")
    ok("restart the billing server so it picks up the claim")

FEATURE_ID = "ai_tokens"
CUSTOMER_ID = "demo-customer"
# Sized so the walkthrough's phases land: phases 2-3 spend ~0.92, phase 4's
# drain loop crosses the reservation hold (~0.82) mid-loop and the NEXT call
# is refused with 402.
STARTING_BALANCE = 3.0

# The console wallet's own grant -- the merchant's budget for their
# dashboard AI, and deliberately NOT the demo customer's 3.
#
# Admission reserves the WORST CASE for a turn: input plus the output cap,
# priced at this org's sheet.  `custom/agnes-2.5-flash` is billed at $20/M in
# / $80/M out, so a turn with no explicit `max_tokens` reserves against the
# gateway's 8192-token ceiling -- 0.66 credits for a single studio prompt.
# A console wallet funded from `demo-starter` (3 credits) is still refused on
# its first prompt once a couple of turns land, which is the whole "agent
# builds a widget" beat gone on a fresh clone.
#
# 250 covers ~380 of those turns, and ~30 even before the studio's output cap
# is applied (billing/server/src/internal/studio/handleStudioAi.ts caps it at
# STUDIO_MAX_OUTPUT_TOKENS, which brings a turn down to ~2 credits).  Generous
# on purpose: the beat has to survive a judge who pokes at it.
CONSOLE_CREDITS = 250.0

# The merchant's COST BASIS per 1M tokens, and the markup applied on top.
#
# These are two different numbers on purpose.  `served_models.input_cost_usd_1m`
# is what the merchant pays their provider; `markup_pct` is what MeterPal adds,
# and the billed rate is cost * (1 + markup/100).  The sheet used to state
# $20/$80 as the cost with a 0% markup, which is a reseller working for free:
# the price was right, but the margin story only appeared after someone edited
# the sheet by hand.  Stating the real cost ($2/$8) and the real markup (900%)
# bills the same $20/$80 while showing the 90% margin at rest.
DEMO_RATES = {"input_cost": 2, "output_cost": 8}
DEMO_MARKUP_PCT = 900

# What the two numbers above bill at, for the messages this script prints.
DEMO_PRICE = {
    "input": DEMO_RATES["input_cost"] * (1 + DEMO_MARKUP_PCT / 100),
    "output": DEMO_RATES["output_cost"] * (1 + DEMO_MARKUP_PCT / 100),
}


def db_name() -> str:
    """Database name from DATABASE_URL in billing/server/.env.

    Falls back to PG_DB. Reading it from the env keeps `table_count()` honest
    when the URL points somewhere other than the default `autumn` database
    (ENV_FILE overrides, a second DB, etc.).
    """
    env_file = ROOT / "billing" / "server" / (os.environ.get("ENV_FILE") or ".env")
    try:
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^\s*DATABASE_URL\s*=\s*(\S+)\s*$", line)
            if m:
                name = m.group(1).split("?")[0].rstrip("/").rsplit("/", 1)[-1]
                if name:
                    return name
    except OSError:
        pass
    return PG_DB


def psql(sql: str) -> str:
    return subprocess.run(
        ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", db_name(), "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True,
    )


def table_count() -> int:
    r = psql("select count(*) from information_schema.tables where table_schema='public'")
    if r.returncode != 0:
        print(r.stdout, r.stderr, sep="\n")
        sys.exit("  psql failed -- is `docker compose up -d` running?")
    # -c output is "count\n-------\n   76\n(1 row)"; take the first numeric line.
    for line in r.stdout.splitlines():
        line = line.strip()
        if line.isdigit():
            return int(line)
    return 0


def migrate(force: bool = False) -> None:
    """Apply the billing schema.

    A fresh clone has no tables: docker/pg-init only installs pg_trgm. Without
    this, the first INSERT fails with `relation "organizations" does not
    exist`. AUTUMN_DB_DIRECT=1 is required or the script tries to spawn
    `infisical` for secrets and dies.
    """
    count = table_count()
    if count > 0 and not force:
        ok(f"schema present ({count} tables)")
        return

    # `bun db migrate` reads DATABASE_URL from billing/server/.env via the
    # bunfig preload. On a fresh clone that file does not exist yet, and the
    # failure downstream ("AUTUMN_DB_DIRECT=1 but DATABASE_URL not set") is
    # cryptic -- so check for it up front.
    env_file = ROOT / "billing" / "server" / ".env"
    if not env_file.exists():
        sys.exit(
            f"  {env_file.relative_to(ROOT)} is missing.\n"
            "  copy the example first:\n"
            "    cp billing/server/.env.example billing/server/.env\n"
            "  then re-run this command."
        )

    step("0. Migrate the billing database")
    env = {**os.environ, "AUTUMN_DB_DIRECT": "1"}
    proc = subprocess.run(
        ["bun", "scripts/db/index.ts", "migrate", "--bootstrap"],
        cwd=ROOT / "billing", env=env, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        tail = (proc.stdout or "")[-1500:] + (proc.stderr or "")[-800:]
        print(tail, sep="\n")
        if "DATABASE_URL not set" in tail:
            sys.exit("  set DATABASE_URL in billing/server/.env (see .env.example)")
        sys.exit("  migration failed -- is `docker compose up -d` running?")
    ok(f"schema migrated ({table_count()} tables)")


def require_server() -> None:
    """Seeding goes through the API, so the billing server has to be up."""
    try:
        with httpx.Client(base_url=BASE_URL, timeout=5) as c:
            c.get("/health")  # 401 is fine: it answered
    except Exception:
        sys.exit(
            "  the billing server is not reachable on :8080.\n"
            "  bootstrap seeds through the API, so start it first:\n"
            "    cd billing/server && bun src/index.ts"
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


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Seed a MeterPal org for the local demo and bind the stack to it.",
    )
    ap.add_argument(
        "--admin",
        metavar="EMAIL",
        help="email the first dashboard sign-in should claim this org with (as owner)",
    )
    ap.add_argument("--org", default="org_demo", help="organization id (default: org_demo)")
    ap.add_argument("--slug", default="demo", help="organization slug (default: demo)")
    ap.add_argument("--org-name", default="Demo Org", help="display name (default: Demo Org)")
    ap.add_argument(
        "--migrate",
        action="store_true",
        help="apply the billing schema and exit (run before starting the server)",
    )
    ap.add_argument(
        "--no-bind",
        action="store_true",
        help="seed only; skip pointing the demo app at this org",
    )
    return ap.parse_args()


def bind_stack() -> None:
    """Point the gateway, the billing server and the demo app at this org."""
    try:
        from bind import bind_org
    except ImportError:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from bind import bind_org
    bind_org({"id": ORG_ID, "slug": ORG_SLUG, "name": ORG_NAME})


def main() -> None:
    global ORG_ID, ORG_SLUG, ORG_NAME
    args = parse_args()
    ORG_ID, ORG_SLUG, ORG_NAME = args.org, args.slug, args.org_name

    # Step 0 runs before anything touches the database. A fresh clone has an
    # empty Postgres (docker/pg-init only installs pg_trgm), so every INSERT
    # below would die with `relation "organizations" does not exist`.
    if args.migrate:
        migrate()
        print("\n\033[1;32mSchema ready.\033[0m  start the services, then re-run "
              "without --migrate to seed the demo org.")
        return
    migrate()

    # Seeding goes through the HTTP API, so the server has to be listening.
    require_server()

    hashed = hashlib.sha256(METERPAL_SECRET_KEY.encode()).hexdigest()

    step("1. Bootstrap org + secret key (psql)")
    r = psql(f"""
        INSERT INTO organizations (id, slug, name, "createdAt", created_at, config, is_sandbox, onboarded, deployed)
        VALUES ('{ORG_ID}', '{ORG_SLUG}', '{ORG_NAME}', NOW(), {int(time.time() * 1000)}, '{{}}'::jsonb, false, true, false)
        ON CONFLICT (slug) DO NOTHING;
        -- A freshly seeded org has not gone to production, and the dashboard
        -- reads `deployed` to decide where "/" lands. Left true (the column
        -- default) you land on the Production catalog, which is empty because
        -- everything seeded here is sandbox -- which reads as a broken demo.
        UPDATE organizations SET deployed = false WHERE id = '{ORG_ID}';
        -- The demo org is the merchant's OWN org, not a sandbox sub-org: is_sandbox
        -- marks a sub-org of a master. The demo runs in the sandbox *env* through
        -- its key below. Older seeds set is_sandbox = true, which made the
        -- dashboard refuse /v1/sandboxes.list with a 400 ("sandboxes are managed
        -- from your main organization"). Repair it on every bootstrap.
        UPDATE organizations SET is_sandbox = false WHERE id = '{ORG_ID}';
        -- Upsert the hash: every run mints a fresh key, so an existing row must
        -- take the new hash (a stale one would 401 the freshly written .env).
        INSERT INTO api_keys (id, name, prefix, org_id, env, hashed_key, scopes)
        VALUES ('{KEY_ID}', 'Demo bridge key', 'am_sk_test', '{ORG_ID}', 'sandbox', '{hashed}', NULL)
        ON CONFLICT (id) DO UPDATE SET hashed_key = EXCLUDED.hashed_key;
    """)
    if r.returncode != 0:
        print(r.stdout, r.stderr, sep="\n")
        sys.exit("  psql failed -- is docker compose up?")
    write_gateway_env_key()
    ok(f"org '{ORG_SLUG}' + fresh secret key minted -> gateway/.env (PAB_API_KEY) + billing/server/.env (AUTUMN_SECRET_KEY) (sha256 stored, key never logged)")
    ok("restart the gateway, the billing server and the demo app so they pick up the new key")

    step("1b. Clear agent proposals from previous demo runs")
    r = psql("delete from agent_proposals;")
    if r.returncode != 0:
        print(r.stdout, r.stderr, sep="\n")
        sys.exit("  psql failed clearing agent_proposals -- is docker compose up?")
    ok("agent proposals cleared (the sales agent starts every demo with a clean inbox)")

    step("2. Create ai_tokens feature (AI credit system)")
    with httpx.Client(base_url=BASE_URL, headers={"Authorization": f"Bearer {METERPAL_SECRET_KEY}"}, timeout=15) as c:
        feature_body = {
            "id": FEATURE_ID,
            "feature_id": FEATURE_ID,
            "name": "AI Tokens",
            "type": "ai_credit_system",
            "consumable": True,
            "display": {"singular": "credit", "plural": "credits"},
            "default_markup": DEMO_MARKUP_PCT,
            "model_markups": {
                "custom/demo-gpt": {
                    "markup": DEMO_MARKUP_PCT,
                    "input_cost": DEMO_RATES["input_cost"],
                    "output_cost": DEMO_RATES["output_cost"],
                },
                # Agnes AI (real model, free trial tier) — same demo rates
                # so the wallet visibly drains. Real list prices are
                # $0.05/M in, $0.15/M out.
                "custom/agnes-2.5-flash": {
                    "markup": DEMO_MARKUP_PCT,
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
               f"${DEMO_PRICE['input']}/M in, ${DEMO_PRICE['output']}/M out billed "
               f"(cost ${DEMO_RATES['input_cost']}/${DEMO_RATES['output_cost']}, "
               f"{DEMO_MARKUP_PCT}% markup)")
        else:
            resp = api_call(c, "POST", "/v1/features", json=feature_body)
            if resp.status_code >= 300:
                sys.exit(f"  feature create failed: {resp.status_code} {resp.text[:400]}")
            ok(f"feature '{FEATURE_ID}' (1 credit = $1 of billed cost; custom/demo-gpt at "
               f"${DEMO_PRICE['input']}/M in, ${DEMO_PRICE['output']}/M out)")

        step("2b. Reset the served-model price sheet (the org's own prices -- "
             "they WIN over the feature markups, so the walkthrough's printed "
             "expected-costs stay truthful even after dashboard edits)")
        for sheet in [
            # model_id, display name, cost $/1M in, cost $/1M out, markup %
            ("custom/demo-gpt", "Demo GPT (mock)", DEMO_RATES["input_cost"], DEMO_RATES["output_cost"], DEMO_MARKUP_PCT),
            # gpt-4o-mini at true models.dev list rates for phase 3. No
            # markup: this one is here to show the sheet can carry a model at
            # cost, next to two that carry a margin.
            ("openai/gpt-4o-mini", "GPT-4o mini (mock)", 0.15, 0.60, 0),
            # Agnes AI — the real model the sales agent's own brain runs on.
            # MeterPal meters its own agents: every negotiation turn costs the
            # agent-sales wallet (see step 4c below).
            ("custom/agnes-2.5-flash", "Agnes 2.5 Flash (real)", DEMO_RATES["input_cost"], DEMO_RATES["output_cost"], DEMO_MARKUP_PCT),
        ]:
            model_id, display, cin, cout, markup = sheet
            resp = api_call(c, "POST", "/v1/served_models", json={
                "model_id": model_id,
                "display_name": display,
                "enabled": True,
                "input_cost_usd_1m": cin,
                "output_cost_usd_1m": cout,
                "markup_pct": markup,
            })
            if resp.status_code >= 300:
                sys.exit(f"  served-model upsert failed for {model_id}: "
                         f"{resp.status_code} {resp.text[:300]}")
            billed_in = cin * (1 + markup / 100)
            billed_out = cout * (1 + markup / 100)
            ok(f"price sheet: {model_id} cost ${cin}/${cout} · {markup}% markup "
               f"→ bills ${billed_in}/${billed_out} per 1M")

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
            # Deliberately left nearly empty.
            #
            # The switcher has two personas and they are not interchangeable:
            # demo-customer is the funded one (charts, studio turns, the
            # agentic-loop beats), and demo-customer-2 is the one who has run
            # out -- the 402 paywall beat needs a wallet below one turn's
            # worst-case reservation (~0.66 credits at the demo sheet), and a
            # freshly attached plan hands out 3. Draining it here means the
            # paywall is reproducible on a fresh clone instead of depending on
            # how much someone happened to spend in an earlier session.
            drain = api_call(c, "POST", "/v1/customers/demo-customer-2/balances", json={
                "balances": [{"feature_id": FEATURE_ID, "balance": 0.2}],
            })
            if drain.status_code >= 300:
                print(f"  ! customer-2 drain failed: {drain.status_code} {drain.text[:300]}")
            else:
                ok("customer 'demo-customer-2' left at 0.20 credits "
                   "(the paywall persona -- one turn reserves ~0.66)")

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

        step("4b3. Create the merchant's console wallet (the dashboard's own AI bills here)")
        # The Usage Studio assistant and every later console agent bill THIS
        # wallet, never the customer the dashboard is showing.  Server side:
        # billing/server/src/internal/studio/studioWallet.ts (STUDIO_WALLET_ID).
        # It is created on the first studio turn if it is missing; seeding it
        # here means the demo opens with a funded assistant instead of meeting
        # a paywall on the first prompt.
        resp = api_call(c, "DELETE", "/v1/customers/meterpal-console")
        resp = api_call(c, "POST", "/v1/customers", json={
            "id": "meterpal-console",
            "name": "MeterPal Console",
            "email": "console@meterpal.local",
        })
        if resp.status_code >= 300:
            print(f"  ! meterpal-console create failed: {resp.status_code} {resp.text[:300]}")
        else:
            ok("customer 'meterpal-console' created (auto-attached to 'demo-starter'; "
               "every dashboard AI turn is billed here, never to an end user)")
            # Fund it.  `demo-starter` grants 3 credits -- the demo customer's
            # budget, not the merchant's console budget.  Setting the balance
            # directly alters the granted balance, so this is a real grant and
            # the ledger shows it, rather than a number the UI invents.
            grant = api_call(c, "POST", "/v1/customers/meterpal-console/balances", json={
                "balances": [{"feature_id": FEATURE_ID, "balance": CONSOLE_CREDITS}],
            })
            if grant.status_code >= 300:
                print(f"  ! console wallet grant failed: {grant.status_code} {grant.text[:300]}")
            else:
                ok(f"console wallet granted {CONSOLE_CREDITS:.0f} credits "
                   f"(a studio turn reserves up to ~0.66 -- see CONSOLE_CREDITS)")

        step("4c. Register the PayPal webhook (sandbox) if keys are configured")
        # Reads billing/server/.env as well as the shell: the dashboard writes
        # PayPal credentials there.
        if env_value("PAYPAL_CLIENT_ID") and env_value("PAYPAL_CLIENT_SECRET") and env_value("PAYPAL_WEBHOOK_URL"):
            register_paypal_webhook()
        else:
            ok("skipped (set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET + PAYPAL_WEBHOOK_URL "
               "to auto-register; see step 4c notes above)")

        step("5. Verify admission check")
        resp = api_call(c, "POST", "/v1/check", json={
            "customer_id": CUSTOMER_ID,
            "feature_id": FEATURE_ID,
            "required_balance": 0.5,
        })
        print(f"  /check -> {resp.status_code} {json.dumps(resp.json(), indent=2)[:300]}")
        if resp.status_code >= 300 or not resp.json().get("allowed"):
            sys.exit("  /check did not allow the seeded customer")

    if args.admin:
        step("6. First-run claim for the dashboard")
        write_first_run_claim(args.admin)

    if not args.no_bind:
        step("7. Bind the demo app to this org")
        bind_stack()

    print("\n\033[1;32mBootstrap complete.\033[0m")
    print("  restart the gateway, the billing server and the demo app to pick up the new key")
    if args.admin:
        print(f"  then sign in at http://localhost:3000 with \033[1m{args.admin}\033[0m")
    else:
        print("  re-run with --admin you@example.com to claim this org from the dashboard")


if __name__ == "__main__":
    main()
