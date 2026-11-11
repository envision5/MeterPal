# First run: clone → merchant → metered call

This is the path a judge takes. It ends with a merchant you own, a storefront
that bills it, and a ledger that shows the money moving.

Three beats: start the infrastructure, create the schema, seed an org. Then you
start six processes and look at what they show. The order matters in one place —
the gateway and the demo app read the merchant key when they boot, so the seed
has to run before they start.

---

## 0. Prerequisites

| Need | Why |
|---|---|
| Docker Desktop, **engine running** | Postgres (billing + gateway) and Redis |
| `bun` | billing server, dashboard, demo app |
| Python 3.11+ with `httpx` | the seed and bind scripts |
| LiteLLM installed (`pip install -e ".[proxy]"` in `gateway/`) | the metered gateway (:4000) |
| ~4 GB free RAM | six processes plus two databases |

If `litellm` is not on your `PATH` after installing it, use the absolute path
to the console script (`…/Python3xx/Scripts/litellm.exe` on Windows,
`…/bin/litellm` on macOS/Linux). The docs below use the bare command.

`bootstrap.py` is the only step that writes to the database directly. It hashes
the demo key with SHA-256 and never prints it.

---

## 1. Start the infrastructure

```bash
docker compose up -d
```

`docker ps` should show four healthy containers:

```
meterpal-postgres-billing   :5433
meterpal-postgres-gateway   :5434
meterpal-redis-billing      :6380
meterpal-redis-gateway      :6381
```

---

## 2. Configure and create the schema

```bash
cp billing/server/.env.example billing/server/.env
cp gateway/.env.example        gateway/.env
cp billing/vite/.env.example   billing/vite/.env

python demo/bootstrap.py --migrate
```

The three examples are pre-filled for localhost — there is nothing to edit.
The last line is the one people skip, and it is the one that matters:

> **A fresh database has no tables.** `docker/pg-init` only installs the
> `pg_trgm` extension; the 76 application tables are created by the migration.
> Without this step the seed dies on `relation "organizations" does not exist`,
> and the billing server answers every request with a 500.

`--migrate` is a thin wrapper over
`bun scripts/db/index.ts migrate --bootstrap` that sets `AUTUMN_DB_DIRECT=1`
(which stops the script from spawning Infisical for secrets) and reads
`DATABASE_URL` from `billing/server/.env`. It is a no-op once the schema
exists, so it is safe to run every time. If you run the bun command yourself,
keep the flag — without it you get
`failed to spawn infisical: Executable not found in $PATH`.

---

## 3. Start the billing server and the two mocks

Three of the six processes. Each needs its own terminal, and each must run with
the shell's HTTP proxy disabled — see [Troubleshooting](#10-troubleshooting) for
why.

```bash
# mock LLM provider (:9999)
python demo/mock_llm.py

# mock Google OAuth + email inbox (:9998)
python demo/mock_cloud.py

# billing server (:8080) — takes ~2 minutes to bind, this is normal
cd billing/server && \
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy && \
  export NO_PROXY=localhost,127.0.0.1 NODE_ENV=development && \
  bun src/index.ts
```

The billing server has to be up before the next step: `bootstrap.py` seeds
through the HTTP API, not through SQL. If it is not listening, the seed stops
with an explicit message rather than a stack trace.

---

## 4. Seed and bind — one command

```bash
python demo/bootstrap.py --admin you@example.com
```

Substitute your own email; that is the identity you will sign in with in step 6.
The script is idempotent — re-run it as often as you like.

What it does, in order:

| Step | Effect |
|---|---|
| 0 | Migrates the schema if it is missing (the same check as step 2) |
| 1 | Creates org `org_demo`, marked `deployed = false` so the dashboard opens on Sandbox rather than the empty Production catalog, and mints a sandbox secret key |
| 1b | Clears agent proposals so the sales-agent demo starts with a clean inbox |
| 2 | Creates the `ai_tokens` credit meter and the per-model price sheet |
| 3 | Creates the starter catalog: `demo-starter` (free, 3 credits/mo), `pro` ($20/mo, 100 credits), top-ups of 10/50/200 |
| 4 | Creates the demo customers and their wallets |
| 5 | Verifies admission control allows a metered call |
| 6 | Writes `METERPAL_FIRST_RUN_ORG` + your email into `billing/server/.env` |
| 7 | Binds the stack: key into `gateway/.env` and `billing/server/.env`, demo-app binding into `demo-app/.env.local` + `demo-app/.binding.json` |

Expected tail:

```
== 7. Bind the demo app to this org ==
  org        Demo Org  (org_demo / demo)
  key        am_sk_test_260…  (sandbox, sha256 stored)
  feature    ai_tokens
  model      custom/demo-gpt
  customers  demo-customer, demo-customer-2
  plans      demo-starter, pro
  top-ups    topup_10, topup_50, topup_200
  wrote      gateway/.env, billing/server/.env, demo-app/.env.local, demo-app/.binding.json
```

**Why step 6 matters.** Without it, the first dashboard sign-in finds no
membership for your user and creates `"Your Name's Org"` — an empty org with no
plans, no models and no wallet. The dashboard would then describe a different
merchant from the one the demo app bills, and every screen would look broken for
a reason that has nothing to do with the code.

With it, `createDefaultOrg.ts` sees the configured email and makes you **owner**
of that org. The email is the gate, so re-running `bootstrap.py --admin` with the
same address is idempotent — you land back in the same org, never in a new one.
The branch never runs when the variable is unset, which is always the case in
production.

> Every run mints a **new** key and overwrites it in `gateway/.env`,
> `billing/server/.env` and `demo-app/.env.local`. Anything already running
> holds the old one and will 401 until it restarts. That is why steps 3 and 5
> are ordered around this command.

---

## 5. Start the gateway, the dashboard and the demo app

The three processes that consume the key written above. Start them after the
seed, not before.

```bash
# metered gateway (:4000)
cd gateway && set -a && source .env && set +a && \
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy && \
  export NO_PROXY=localhost,127.0.0.1 && \
  litellm --config config.yaml --port 4000

# merchant dashboard (:3000)
cd billing/vite && \
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy && \
  export NO_PROXY=localhost,127.0.0.1 && bun run dev

# customer-facing demo app (:5173)
cd demo-app && \
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy && \
  export NO_PROXY=localhost,127.0.0.1 && bun run dev
```

Wait for all six:

| Port | Service | Started in |
|---|---|---|
| 9999 | mock LLM provider | step 3 |
| 9998 | mock Google OAuth + email | step 3 |
| 8080 | billing server | step 3 |
| 4000 | metered gateway | step 5 |
| 3000 | merchant dashboard | step 5 |
| 5173 | demo app (the storefront) | step 5 |

---

## 6. Sign in

Open **http://localhost:3000** and choose **Continue with Google**.

The Google screen is `demo/mock_cloud.py`, a local stand-in that issues the same
OAuth callback a real provider would. Pick `merchant@meterpal.dev`, or type the
email you passed to `--admin`. It must match, or the claim `bootstrap.py` wrote
will not apply and you will land in a fresh empty org.

Email sign-in also works: any address, with the one-time code delivered to
**http://localhost:9998/inbox**.

You should land on **Demo Org**, in the **Sandbox** environment, on **Get
started** showing **4 of 5** complete — plans, a customer, a feature and usage
tracking already done, with "Go to production" left as the next step. Not on
"Create your plans", and not on an empty Production catalog.

The environment selector at the top reads **Sandbox** because the seeded org is
`deployed = false`. Production is intentionally empty: everything this demo
creates is sandbox, and publishing to production is a separate action the demo
never takes.

---

## 7. What you are looking at

The dashboard and the demo app are two views of one org. This is the map:

| Dashboard screen | What it proves | Where it shows up in the demo app |
|---|---|---|
| **Features** | `ai_tokens` is the meter; every chat call decrements it | the credits chip under each reply |
| **Plans** | `demo-starter` (free) and `pro` ($20/mo) | the two plan cards |
| **Plans → add-ons** | the 10/50/200 credit packs | the "Buy credits with PayPal" modal |
| **Models** | `custom/demo-gpt` and its per-million prices | the model switcher, and the cost of each turn |
| **Customers** | `demo-customer` (3.00 credits) and `demo-customer-2` | the customer switcher |
| **API keys** | the sandbox key the demo app is using | `demo-app/.env.local` |
| **Webhooks** | PayPal event subscriptions | checkout → credit top-up |

Open **http://localhost:5173** side by side. Send a message. Then come back to
the dashboard: **Customers → demo-customer → usage** shows the same call.

### The metered loop

One chat turn runs the full cycle:

```
reserve   +0.6554     # admission control holds an estimate
release   -0.6554     # the estimate is given back
settle     0.00516    # the actual cost, from token counts
```

The reply carries `meterpal.credits_charged`, and the wallet balance drops by
exactly that. When the wallet cannot cover the next reservation, the call is
refused with a `402` and the demo app shows the paywall.

One display note: the credits pill rounds to two decimals, so a single turn
(`~0.005`) may not visibly move `2.98`. The per-message `charged … credits` chip
and the "spent this month" line are the proof; send a handful of messages to see
the balance move, or read the ledger directly.

Prefer the terminal? `python demo/run_demo.py` drives the same loop through the
gateway and prints the 402 → top-up → resume story in eight calls.

---

## 8. Prove it is live

Change something in the dashboard and watch the storefront follow:

1. **Plans → MeterPal Pro →** change the price from `$20` to `$25`, save.
2. Reload **http://localhost:5173**.
3. The card now reads `$25`.

Nothing was rebuilt and no config was edited — the card reads the same API the
dashboard writes to. Same for the top-up row: the demo app derives its buttons
from the add-on catalog on every load, so adding a pack in the dashboard adds a
button in the storefront.

---

## 9. Point the stack at a different org

Any org, including one you built by hand in the dashboard:

```bash
python demo/bind.py --org <org_id_or_slug>
```

Then restart the gateway, the billing server and the demo app. Verify:

```bash
python demo/bind.py --check
```

It asserts that the key resolves to the bound org, that every bound top-up is
still in the catalog, that the model is served, and that the gateway holds the
same key. Non-zero exit means the binding is stale.

`--dry-run` prints the binding without writing anything.

---

## 10. Troubleshooting

These are the failures that actually happen on a first run, in the order they
bite.

| Symptom | Cause | Fix |
|---|---|---|
| `docker compose up` hangs or errors | Docker engine not started | Start Docker Desktop, wait for "Engine running" |
| `relation "organizations" does not exist` | the schema was never created | `python demo/bootstrap.py --migrate` |
| `failed to spawn infisical: Executable not found in $PATH` | `bun db migrate` without `AUTUMN_DB_DIRECT=1` | re-run `python demo/bootstrap.py --migrate`, or prefix the bun command with `AUTUMN_DB_DIRECT=1` |
| `bootstrap.py` exits: "the billing server is not reachable on :8080" | the seed goes through the API | start `billing/server` (step 3), then re-run |
| Gateway exits at import: `No module named 'websockets'` | `pip install -e .` omits the proxy extras | `pip install -e ".[proxy]"` in `gateway/` |
| Gateway exits: `Unable to find Prisma binaries` | Prisma client never generated | `pip install prisma`, then `prisma generate --schema litellm/proxy/schema.prisma` with Python's `Scripts/` on `PATH` |
| `/v1/keys` returns 500, gateway log shows `GET http%3A//localhost%3A4000/...` | a shell `HTTP_PROXY` is rewriting bun's localhost calls | start every service with the proxy env unset, as in steps 3 and 5 |
| Dashboard 401s on `/api/autumn/*` | `AUTUMN_SECRET_KEY` is older than `PAB_API_KEY` | re-run `bootstrap.py`, restart the billing server |
| Port 8080 refuses for two minutes | the billing server is still booting | wait; it is not a crash |
| Log says `WORKER FATAL uncaughtException … Is port 8080 in use?` **but the API answers** | `bun src/index.ts` forks a worker fleet; one worker wins the port and a sibling exits | not a crash — ignore it as long as `curl :8080/health` returns 401 |
| `bash: litellm: command not found` | the console script is not on this shell's `PATH` | call it by absolute path (`python -c "import litellm"` still works), or add Python's `Scripts/` to `PATH` |
| The wallet balance falls with nobody typing | the storefront tab runs a buyer-agent watchdog and the sales agent makes small metered turns while open | expected; close the tab, or top up. Not a leak — reserve/release pairs net to exactly 0 |
| Signed in, but the org is empty | your email did not match `--admin` | `python demo/bind.py --check`, then re-run `bootstrap.py --admin <your email>` |
| Signed in, but you land in some other org | that email already belongs to an org from an earlier session; the **most recent** membership wins | sign in with the email you passed to `--admin`, or remove the stale `member` row |
| Dashboard says "Create your plans" while plans exist | you are on **Production**; the seed is sandbox-only | switch the env selector to **Sandbox**, or set `deployed = false` on the org |
| Demo app shows no plans | binding is stale after an org switch | `python demo/bind.py --org <id>`, restart the demo app |
| Demo chat errors on every send | the gateway or the mock LLM is not up | check :4000 and :9999; the gateway needs `MOCK_LLM_BASE_URL` from `gateway/.env` |

---

## 11. What is sandbox and what is production

Everything here is **sandbox**. Every product in the catalog carries
`env = sandbox`, the key is `am_sk_test_…`, and the dashboard shows the Sandbox
badge. No production rows exist in a fresh database; publishing a plan to
production is a separate action the demo never takes.

PayPal checkout is sandbox too. Buying credits creates a real sandbox order, but
crediting the wallet needs a webhook the PayPal servers can reach — set
`PAYPAL_WEBHOOK_URL` to a tunnel and re-run `bootstrap.py` to register it.
Metering, the paywall and the ledger all work without it.
