# Testing MeterPal's SDKs locally

This is the path for evaluating the SDKs specifically: install them the way a
merchant would, point them at this repo's stack, and watch one call get admitted,
metered and charged.

Two levels, both worth running:

| Level | Needs | Proves |
|---|---|---|
| **Unit tests** | nothing but bun / Python | the client contract — request shapes, typed errors, retries, SSE parsing |
| **Live checks** | the stack on :8080 + :4000 | the real loop: admission → inference → token metering → wallet debit → `402` |

Everything here is **sandbox**. No PayPal account, no provider key, no credit
card. The bundled mock LLM answers the calls.

---

## 0. Prerequisites

| Need | Why |
|---|---|
| Docker Desktop, engine running | Postgres ×2 and Redis ×2 |
| `bun` | billing server, the TS SDK, the CLI |
| Python 3.11+ | the Python SDK, bootstrap |
| Node 18+ | running the CLI's built output |
| ~4 GB free RAM | six processes plus two databases |

Commands are Git Bash / macOS / Linux syntax. On Windows, Git Bash is what the
repo is verified against.

---

## 1. Start the stack

The full walkthrough is [`FIRST-RUN.md`](FIRST-RUN.md). The SDK only needs two
of the six processes — the billing server and the gateway — but the demo seed
needs the rest, so the short version is:

```bash
docker compose up -d

cp billing/server/.env.example billing/server/.env
cp gateway/.env.example        gateway/.env
cp billing/vite/.env.example   billing/vite/.env

python demo/bootstrap.py --migrate        # creates the 76 tables — do not skip

python demo/mock_llm.py &                 # :9999 the "provider"
python demo/mock_cloud.py &               # :9998 local OAuth + inbox
( cd billing && bun install && cd server && bun src/index.ts ) &   # :8080, ~2 min to bind

until (echo > /dev/tcp/127.0.0.1/8080) 2>/dev/null; do sleep 5; done

python demo/bootstrap.py --admin you@example.com   # seeds org, mints the key

( cd gateway && set -a && source .env && set +a && pip install -e ".[proxy]" \
    && litellm --config config.yaml --port 4000 ) &                 # :4000
until (echo > /dev/tcp/127.0.0.1/4000) 2>/dev/null; do sleep 5; done
```

Check both are answering before going further:

```bash
curl -s -o /dev/null -w "billing %{http_code}\n"  http://localhost:8080/health
curl -s -o /dev/null -w "gateway %{http_code}\n"  http://localhost:4000/health
```

`401` on `/health` is the expected answer from both — it means the port is
serving and the auth middleware is in front of it.

---

## 2. Get the merchant key

The SDK authenticates as a merchant. `bootstrap.py` mints that key and writes it
to `gateway/.env` as `PAB_API_KEY`; it is never committed.

```bash
export METERPAL_SECRET_KEY=$(grep '^PAB_API_KEY=' gateway/.env | cut -d= -f2)
export METERPAL_BASE_URL=http://localhost:8080
```

> **The key is re-minted on every `bootstrap.py` run.** Anything already running
> holds the old one and answers `401` until it restarts. If a live check suddenly
> says `Invalid secret key`, re-export the variable and restart the services.

---

## 3. TypeScript SDK

### 3a. Unit tests — no stack needed

```bash
cd sdk/typescript
bun install
bun run test      # 24 tests: request shape, typed errors, SSE, balance math, components
bun run lint      # tsc --noEmit
```

### 3b. Live check — the real loop

From the repo root, with the two variables from step 2 exported:

```bash
bun run sdk/typescript/scripts/live-check.ts
```

It asserts ten things and exits non-zero if any of them fails:

```
1. the merchant's served catalog
   custom/demo-gpt (demo-gpt) enabled=true in=20 out=80 per 1M
   ✓ the catalog lists at least one served model

2. a metered call
   charged 0.00518 credits, balance now 29.38 (model custom/demo-gpt, 3 in / 64 out)
   ✓ the call reports a non-zero credits_charged
   ✓ the charge is attributed to the end user in `user`

3. a streamed call
   ✓ the stream yields content chunks
   ✓ the final stream payload carries the charge

4. an unknown model is refused
   refused: Model gpt-4o-mini is not in this organization's served catalog
   ✓ an off-sheet model was refused

5. a customer who cannot pay hits the paywall
   ✓ the paywall probe customer exists (200)
   ✓ the probe wallet is set to 0 (200)
   paywall: balance 0, needs 0.5, customer meterpal-livecheck-paywall
   topUp() is wired: true
   ✓ a customer with no credits was refused with 402
   ✓ the paywall error can open a checkout

SDK live check: OK
```

Step 5 is deterministic: it creates a dedicated probe customer and sets that
wallet to `0` before calling, so the `402` cannot be masked by a balance a
previous run left behind. The `meterpal` block on step 2 is the charge itself —
`credits_charged` is what the call cost, computed from the token counts the
provider reported.

### 3c. Install it into your own app

This is what a merchant actually does — and it is the same two lines the README
promises:

```bash
mkdir -p ../my-ai-app && cd ../my-ai-app
bun init -y
bun add file:../meterpal/sdk/typescript
```

`dist/` is committed in this repo, so the package resolves immediately; you do
not build anything first.

Then make one call (server-side — never in a browser bundle):

```ts
import { createMeterPal } from "@meterpal/sdk";

const meterpal = createMeterPal({
	apiKey: process.env.METERPAL_SECRET_KEY!,
	baseURL: process.env.METERPAL_BASE_URL,   // http://localhost:8080 here
});

const completion = await meterpal.chat.completions.create({
	model: "custom/demo-gpt",
	messages: [{ role: "user", content: "hi" }],
	user: "demo-customer",     // the end user being billed
});

console.log(completion.meterpal.credits_charged);
```

### 3d. Let the CLI write the integration

```bash
bunx meterpal init --help
```

Against this stack, non-interactively:

```bash
bunx meterpal init --yes \
  --api-key "$METERPAL_SECRET_KEY" \
  --api-url http://localhost:8080 \
  --cwd ../my-ai-app
```

It detects the framework (Next, Express, Hono, Fastify, plain Node), writes
`.env` with the key and base URL, and writes a server-side handler that keeps the
secret off the browser. Add `--dry-run` to see the files without writing them.

The generated Express handler is a complete, working integration — mount it and
`curl` it:

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "x-user-id: demo-customer" \
  -d '{"messages":[{"role":"user","content":"hello"}]}' | jq .meterpal
```

You get the OpenAI response plus the charge, and `demo-customer`'s balance moves
by exactly that amount.

---

## 4. Python SDK

### 4a. Install

```bash
python -m pip install -e sdk/python
```

> Use `python -m pip`, not bare `pip`. On a machine with several interpreters
> those can differ, and the package installs somewhere your `python` cannot see —
> the symptom is `ModuleNotFoundError: No module named 'meterpal'` right after a
> successful install.

### 4b. Unit tests — no stack needed

```bash
python -m pytest sdk/python/tests -q      # 24 tests, httpx MockTransport
```

### 4c. Live check

```bash
export METERPAL_SECRET_KEY=$(grep '^PAB_API_KEY=' gateway/.env | cut -d= -f2)
export METERPAL_BASE_URL=http://localhost:8080
python sdk/python/scripts/live_check.py
```

Same five steps and the same assertions as the TypeScript check; it exits
non-zero if any of them fails.

### 4d. The one-import swap

```python
from meterpal import create_meterpal, InsufficientBalanceError

meterpal = create_meterpal(api_key="am_sk_test_...", base_url="http://localhost:8080")

try:
    completion = meterpal.chat.completions.create(
        model="custom/demo-gpt",
        messages=[{"role": "user", "content": "hi"}],
        user="demo-customer",
    )
    print(completion["meterpal"]["credits_charged"])
except InsufficientBalanceError as err:
    print("paywall:", err.balance, "needs", err.required_credits)
    print("checkout:", err.top_up()["url"])
```

---

## 5. Both at once

From the repo root, with the stack up and the key exported:

```bash
bun run test:sdk         # unit tests, both languages
bun run test:sdk:live    # live checks, both languages
```

---

## 6. Why the base URL is the billing server, not the gateway

Both SDKs talk to **one** host: `METERPAL_BASE_URL`. `/v1/keys`,
`/v1/customers`, `/v1/catalog` and `/v1/checkout` are served by the billing
server, and `/v1/chat/completions` is served by the billing server too — it
proxies the call to the metered gateway and links the response back to the charge
the gateway's bridge wrote.

That means **the gateway still has to be running on :4000**, even though the SDK
never addresses it. If it is down, `chat/completions` fails with a gateway error
while the catalog still works — a confusing pair of symptoms. Check :4000 first.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'meterpal'` | `pip` and `python` are different interpreters | `python -m pip install -e sdk/python` |
| `AuthenticationError: Invalid secret key` | the key was re-minted by a later `bootstrap.py` | re-export `METERPAL_SECRET_KEY`, restart services |
| `ConnectionError: Could not reach MeterPal` | nothing on :8080 | start the billing server (step 1); it takes ~2 minutes to bind |
| Catalog works, chat fails | gateway down on :4000 | `litellm --config config.yaml --port 4000` in `gateway/` |
| `502` / `gateway_error` on chat | gateway is up but has no model for `custom/demo-gpt` | re-run `python demo/bootstrap.py`, then restart the gateway |
| Live check says the paywall was not hit | someone topped the probe customer up between runs | re-run it — step 5 resets the wallet to `0` every time |
| `bun add file:` sits at "Resolving dependencies" | no npm registry access from your network | install with network access, or run the checks in-tree (steps 3a/3b need no install) |
| `EPERM` writing to `%TEMP%` during `bun run test` | a locked-down temp dir (some sandboxes) | point `TMPDIR`/`TEMP` at a writable directory |
| The wallet balance falls with nobody typing | the storefront tab (:5173) runs a buyer-agent watchdog with small metered turns | expected; close the tab |

---

## 8. What the live checks actually prove

| Assertion | Guarantee it backs |
|---|---|
| the catalog lists served models | the price sheet is the gateway's allow-list |
| `credits_charged > 0` on a call | usage is metered per token, not per request |
| the charge names the `user` in the request | one end user cannot be billed for another's traffic |
| the stream's last payload carries the charge | streaming is metered on the same ledger |
| an off-sheet model is refused | the merchant's price sheet is enforced |
| a zero-balance customer gets `402` | admission control fires **before** the provider is touched |
| the `402` can open a checkout | the paywall is a path to revenue, not a dead end |
