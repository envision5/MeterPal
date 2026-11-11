#!/usr/bin/env python3
"""
demo/bind.py -- point the whole local stack at one organization.

The dashboard, the metered gateway and the demo app each hold their own copy of
"which org am I?".  When those copies drift, you get the classic local failure:
the demo app bills org A while the dashboard shows org B, and every screen looks
broken for a reason that has nothing to do with the code.

This script is the single writer for that answer.  Given an org, it:

  1. mints a fresh sandbox secret key for it (SHA-256 hashed into api_keys,
     same scheme as server/src/internal/dev/apiKeys/apiKeyUtils.ts),
  2. writes that key into gateway/.env (PAB_API_KEY) and
     billing/server/.env (AUTUMN_SECRET_KEY),
  3. reads the org's live catalog and writes the demo app's binding:
     demo-app/.env.local + demo-app/.binding.json.

After it runs, all three surfaces describe the same merchant.  Re-run it any
time you switch orgs; it is idempotent.

Run:
    python demo/bind.py                      # bind to the org in the current binding
    python demo/bind.py --org org_demo       # by id or slug
    python demo/bind.py --check              # verify the binding still holds
    python demo/bind.py --dry-run            # print the plan, write nothing
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
GATEWAY_ENV = ROOT / "gateway" / ".env"
BILLING_ENV = ROOT / "billing" / "server" / ".env"
DEMO_APP = ROOT / "demo-app"
BINDING_ENV = DEMO_APP / ".env.local"
BINDING_JSON = DEMO_APP / ".binding.json"

DEFAULT_API_URL = "http://localhost:8080"
PG_CONTAINER = "meterpal-postgres-billing"
PG_USER, PG_DB = "autumn", "autumn"

# Add-on ids starting with this prefix are agent-negotiated volume packs: they
# belong in the Offers tab, not in the fixed three-button top-up modal.
NEGOTIATED_PREFIX = "pkg_"

KEY_ID = "key_demo_bridge"


# ---------------------------------------------------------------- console


def step(title: str) -> None:
    print(f"\n\033[1;36m== {title} ==\033[0m")


def ok(msg: str) -> None:
    print(f"  \033[32m✓\033[0m {msg}")


def warn(msg: str) -> None:
    print(f"  \033[33m!\033[0m {msg}")


def die(msg: str) -> None:
    print(f"  \033[31m✗\033[0m {msg}")
    sys.exit(1)


# ---------------------------------------------------------------- postgres


def psql(sql: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            "docker", "exec", PG_CONTAINER,
            "psql", "-U", PG_USER, "-d", PG_DB,
            "-v", "ON_ERROR_STOP=1", "-tAc", sql,
        ],
        capture_output=True,
        text=True,
    )


def resolve_org(ident: str) -> dict:
    """Look up an org by id or slug. Exits with a helpful list if not found."""
    r = psql(
        "select id || '|' || slug || '|' || name from organizations "
        f"where id = '{ident}' or slug = '{ident}' limit 1"
    )
    if r.returncode != 0:
        die(f"psql failed -- is `docker compose up -d` running?\n{r.stderr.strip()}")
    line = r.stdout.strip()
    if not line:
        listing = psql("select id || '  (' || slug || ')' from organizations order by \"createdAt\"")
        die(
            f"no organization '{ident}'.\n"
            f"  available:\n    " + "\n    ".join(listing.stdout.strip().splitlines())
        )
    org_id, slug, name = line.split("|", 2)
    return {"id": org_id, "slug": slug, "name": name}


def org_from_binding() -> str | None:
    """The org the stack is currently bound to, if any."""
    if BINDING_JSON.exists():
        try:
            return json.loads(BINDING_JSON.read_text(encoding="utf-8"))["org"]["id"]
        except Exception:
            pass
    for path, name in ((GATEWAY_ENV, "PAB_API_KEY"), (BILLING_ENV, "AUTUMN_SECRET_KEY")):
        key = read_env_value(path, name)
        if key:
            org = org_for_key(key)
            if org:
                return org
    return None


def org_for_key(key: str) -> str | None:
    hashed = hashlib.sha256(key.encode()).hexdigest()
    r = psql(f"select org_id from api_keys where hashed_key = '{hashed}' limit 1")
    if r.returncode != 0:
        return None
    return r.stdout.strip() or None


def mint_key(org_id: str) -> str:
    """Mint a fresh sandbox key for `org_id` and store only its hash."""
    key = "am_sk_test_" + secrets.token_hex(21)
    hashed = hashlib.sha256(key.encode()).hexdigest()
    r = psql(f"""
        INSERT INTO api_keys (id, name, prefix, org_id, env, hashed_key, scopes)
        VALUES ('{KEY_ID}', 'Demo bridge key', 'am_sk_test', '{org_id}', 'sandbox', '{hashed}', NULL)
        ON CONFLICT (id) DO UPDATE
            SET org_id = EXCLUDED.org_id, hashed_key = EXCLUDED.hashed_key;
    """)
    if r.returncode != 0:
        die(f"could not write the api_keys row:\n{r.stderr.strip()}")
    return key


# ---------------------------------------------------------------- env files


def read_env_value(path: Path, name: str) -> str | None:
    if not path.exists():
        return None
    m = re.search(rf"^{name}=(.*)$", path.read_text(encoding="utf-8"), re.M)
    return m.group(1).strip() if m else None


def set_env(path: Path, name: str, value: str) -> bool:
    """Replace (or append) `name=value`. Returns True when the value changed.

    Line endings are preserved: these files are CRLF on Windows, and a bare
    newline makes dotenv hand the process `value\\r`, which then fails every
    exact-match comparison in silence.
    """
    if not path.exists():
        warn(f"{path.relative_to(ROOT)} missing -- skipped {name}")
        return False
    raw = path.read_text(encoding="utf-8")
    nl = "\r\n" if "\r\n" in raw else "\n"
    lines = raw.splitlines()
    out, replaced, changed = [], False, False
    for line in lines:
        m = re.match(rf"^{name}=(.*)$", line)
        if m:
            changed = m.group(1).strip() != value
            out.append(f"{name}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"{name}={value}")
        changed = True
    path.write_text(nl.join(out) + nl, encoding="utf-8")
    return changed


def write_block(path: Path, values: dict[str, str]) -> None:
    """Write a whole env file, replacing any previous binding block."""
    body = "".join(f"{k}={v}\n" for k, v in values.items())
    path.write_text(
        "# Generated by demo/bind.py -- points the demo app at one organization.\n"
        "# Re-run `python demo/bind.py --org <id>` to repoint; safe to delete.\n" + body,
        encoding="utf-8",
    )


# ---------------------------------------------------------------- catalog


def api_get(c: httpx.Client, path: str) -> dict | None:
    try:
        resp = c.get(path)
        if resp.status_code != 200:
            warn(f"GET {path} -> {resp.status_code}")
            return None
        return resp.json()
    except Exception as exc:  # noqa: BLE001 - catalog is best-effort
        warn(f"GET {path} failed: {exc}")
        return None


def read_catalog(c: httpx.Client) -> dict:
    """The org's live catalog, reduced to what the demo app renders."""
    plans = (api_get(c, "/v1/plans") or {}).get("list", []) or []
    live = [p for p in plans if not p.get("archived")]

    def price_of(plan: dict) -> float:
        items = plan.get("items") or [{}]
        return float((items[0].get("price") or {}).get("amount") or 0)

    topups = [
        {"id": p["id"], "label": p.get("name") or p["id"], "price": price_of(p)}
        for p in live
        if p.get("add_on") and not str(p["id"]).startswith(NEGOTIATED_PREFIX)
    ]
    topups.sort(key=lambda t: t["price"])

    features = (api_get(c, "/v1/features") or {}).get("list", []) or []
    credit = next(
        (f for f in features if f.get("type") == "ai_credit_system"), None
    )

    models = (api_get(c, "/v1/served_models") or {}).get("models", []) or []
    enabled = [m for m in models if m.get("enabled")]
    preferred = next(
        (m for m in enabled if m.get("model_id") == "custom/demo-gpt"),
        next((m for m in enabled if str(m.get("model_id", "")).startswith("custom/")), None),
    )
    model = preferred or (enabled[0] if enabled else None)

    customers = (api_get(c, "/v1/customers") or {}).get("list", []) or []
    # The demo app's switcher is for *people*. Prefer the canonical demo
    # personas, and never hand it the agent's own metering wallet.
    customer_ids = [cu["id"] for cu in customers]
    personas = sorted(i for i in customer_ids if i.startswith("demo-customer"))
    if not personas:
        personas = sorted(i for i in customer_ids if not i.startswith("agent-"))

    return {
        "plans": [p["id"] for p in live if not p.get("add_on")],
        "topups": topups,
        "feature_id": (credit or {}).get("id") or (credit or {}).get("feature_id"),
        "model_id": (model or {}).get("model_id"),
        "customers": personas[:2],
    }


# ---------------------------------------------------------------- binding


def bind_org(
    org: dict,
    *,
    api_url: str = DEFAULT_API_URL,
    dry_run: bool = False,
    quiet: bool = False,
) -> dict:
    """Mint a key for `org`, point every surface at it, return the binding."""
    if dry_run:
        # Never rotate a live key just to preview: reuse whatever the stack is
        # already holding, and only mint if there is nothing to reuse.
        key = (
            read_env_value(BINDING_ENV, "METERPAL_SECRET_KEY")
            or read_env_value(GATEWAY_ENV, "PAB_API_KEY")
            or mint_key(org["id"])
        )
    else:
        key = mint_key(org["id"])
    headers = {"Authorization": f"Bearer {key}"}
    with httpx.Client(base_url=api_url, headers=headers, timeout=20) as c:
        catalog = read_catalog(c)

    binding = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "api_url": api_url,
        "org": org,
        "feature_id": catalog["feature_id"] or "ai_tokens",
        "model_id": catalog["model_id"] or "custom/demo-gpt",
        "customers": catalog["customers"] or ["demo-customer"],
        "plans": catalog["plans"],
        "topups": catalog["topups"],
    }

    if dry_run:
        if not quiet:
            print(json.dumps(binding, indent=2))
        return binding

    changed = set_env(GATEWAY_ENV, "PAB_API_KEY", key)
    changed |= set_env(BILLING_ENV, "AUTUMN_SECRET_KEY", key)

    write_block(
        BINDING_ENV,
        {
            "METERPAL_API_URL": api_url,
            "METERPAL_SECRET_KEY": key,
            "METERPAL_ORG_ID": org["id"],
            "METERPAL_FEATURE_ID": binding["feature_id"],
            "DEMO_MODEL_ID": binding["model_id"],
            "DEMO_CUSTOMER_IDS": ",".join(binding["customers"]),
            "DEMO_TOPUP_PRODUCT_IDS": ",".join(t["id"] for t in binding["topups"]),
        },
    )
    BINDING_JSON.write_text(json.dumps(binding, indent=2) + "\n", encoding="utf-8")

    if not quiet:
        print(f"  org        {org['name']}  ({org['id']} / {org['slug']})")
        print(f"  key        {key[:14]}…  (sandbox, sha256 stored)")
        print(f"  feature    {binding['feature_id']}")
        print(f"  model      {binding['model_id']}")
        print(f"  customers  {', '.join(binding['customers']) or '(none)'}")
        print(f"  plans      {', '.join(binding['plans']) or '(none)'}")
        print(f"  top-ups    {', '.join(t['id'] for t in binding['topups']) or '(none)'}")
        print(f"  wrote      gateway/.env, billing/server/.env, "
              f"demo-app/.env.local, demo-app/.binding.json")
        if changed:
            print("  \033[33m!\033[0m key changed -- restart the gateway, the billing server "
                  "and the demo app")
    return binding


def check(api_url: str = DEFAULT_API_URL) -> int:
    """Verify the binding still describes reality. Non-zero exit on drift."""
    if not BINDING_JSON.exists():
        die("no demo-app/.binding.json -- run `python demo/bind.py --org <id>` first")
    binding = json.loads(BINDING_JSON.read_text(encoding="utf-8"))
    key = read_env_value(BINDING_ENV, "METERPAL_SECRET_KEY")
    problems: list[str] = []

    step("1. Key resolves to the bound org")
    if not key:
        problems.append("demo-app/.env.local has no METERPAL_SECRET_KEY")
    else:
        actual = org_for_key(key)
        if actual == binding["org"]["id"]:
            ok(f"key -> {actual}")
        else:
            problems.append(f"key belongs to {actual or 'no org'}, binding says {binding['org']['id']}")

    step("2. Catalog is served to that key")
    if key:
        with httpx.Client(
            base_url=api_url, headers={"Authorization": f"Bearer {key}"}, timeout=20
        ) as c:
            plans = (api_get(c, "/v1/plans") or {}).get("list", []) or []
            addons = {p["id"] for p in plans if p.get("add_on") and not p.get("archived")}
            missing = [t["id"] for t in binding["topups"] if t["id"] not in addons]
            if missing:
                problems.append(f"top-up ids gone from the catalog: {', '.join(missing)}")
            else:
                ok(f"{len(plans)} products, {len(addons)} add-ons, all bound top-ups present")

            models = (api_get(c, "/v1/served_models") or {}).get("models", []) or []
            ids = {m["model_id"] for m in models if m.get("enabled")}
            if binding["model_id"] in ids:
                ok(f"model {binding['model_id']} is served")
            else:
                problems.append(f"model {binding['model_id']} is not in the served catalog")

    step("3. Gateway holds the same key")
    gateway_key = read_env_value(GATEWAY_ENV, "PAB_API_KEY")
    if gateway_key == key:
        ok("gateway/.env PAB_API_KEY matches the binding")
    else:
        problems.append("gateway/.env PAB_API_KEY does not match -- restart after bind?")

    print()
    if problems:
        for p in problems:
            warn(p)
        print("\n\033[31mBinding is stale. Re-run: python demo/bind.py --org "
              f"{binding['org']['id']}\033[0m")
        return 1
    print("\033[32mBinding is consistent across the gateway, the billing server and the demo app.\033[0m")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="Point the local stack at one organization.")
    ap.add_argument("--org", help="organization id or slug (default: whatever is bound now)")
    ap.add_argument("--api-url", default=DEFAULT_API_URL)
    ap.add_argument("--dry-run", action="store_true", help="print the binding, write nothing")
    ap.add_argument("--check", action="store_true", help="verify the current binding")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    if args.check:
        sys.exit(check(args.api_url))

    ident = args.org or org_from_binding() or "org_demo"
    if not args.json:
        step(f"Binding the stack to '{ident}'")
    org = resolve_org(ident)
    binding = bind_org(
        org, api_url=args.api_url, dry_run=args.dry_run, quiet=args.json
    )
    if args.json:
        print(json.dumps(binding, indent=2))
    elif not args.dry_run:
        print("\n\033[1;32mBound.\033[0m Open the demo app on :5173 -- it now bills "
              f"{binding['org']['name']}.\n")


if __name__ == "__main__":
    main()
