# meterpal (Python)

**MeterPal's SDK for Python** — an OpenAI-shaped client that bills the end user
for every AI call, plus the LiteLLM usage-billing hook.

## Install

Not on PyPI yet. Install it from this repo:

```bash
python -m pip install -e sdk/python              # client (httpx only)
python -m pip install -e "sdk/python[litellm]"   # + gateway hook re-export
```

> Use `python -m pip`, not bare `pip`: on a machine with several Pythons those
> can point at different interpreters, and the package then installs somewhere
> the `python` you run cannot import. Same reason the live check below is run
> with `python -m`.

## One import: metered inference

Swap `from openai import OpenAI` for `from meterpal import create_meterpal`
and every call is admitted, metered and charged to the end user — the same
`chat.completions` shape their app already speaks:

```python
from meterpal import create_meterpal, InsufficientBalanceError

# Server-side only. base_url defaults to https://api.meterpal.dev;
# for this repo's stack pass http://localhost:8080.
meterpal = create_meterpal(api_key="am_sk_test_...", base_url="http://localhost:8080")

try:
    completion = meterpal.chat.completions.create(
        model="custom/demo-gpt",
        messages=[{"role": "user", "content": "hi"}],
        user="cus_123",        # the end user being billed — required
    )
    completion["meterpal"]["credits_charged"]   # what it cost
    completion["meterpal"]["balance_after"]     # their balance once it settled
except InsufficientBalanceError as err:
    # The paywall, as a typed error: open the PayPal checkout for them.
    checkout = err.top_up()
    send_user_to(checkout["url"])   # err.balance, err.required_credits too
```

Streaming works the same way (`meterpal.chat.completions.stream(...)` yields
OpenAI chunks; the final payload is the `meterpal` charge block), and
`meterpal.keys.provision(customer_id)` / `meterpal.models.list()` cover the
rest of the merchant surface. The secret key is exchanged for a per-customer
virtual key on first use and cached, so one merchant's traffic can never
spend another merchant's budget.

## Billing client

`MeterPalClient` is the lower-level REST client — the merchant surface the
gateway and the PayPal webhooks use. Most apps only need `create_meterpal`
above; reach for this to seed customers or to inspect a wallet.

```python
from meterpal import MeterPalClient

billing = MeterPalClient(
    secret_key="am_sk_test_...",
    base_url="http://localhost:8080/v1",   # the default
)

# customers (get-or-create semantics)
billing.get_or_create_customer("cus_123", email="user@example.com")

# admission control — refuse BEFORE the model call when balance is too low
res = billing.check("cus_123", required_balance=0.5)
if not res["allowed"]:
    raise RuntimeError("insufficient balance")

# meter a completed call (idempotent — safe to retry)
billing.track_tokens(
    "cus_123", "ai_tokens", "custom/demo-gpt",
    input_tokens=10_000, output_tokens=2_000,
    idempotency_key="my-unique-call-id",
    properties={"cost_usd": 0.31},
)

# grant credits (what the PayPal webhook path calls automatically)
billing.update_balance("cus_123", "ai_tokens", add_to_balance=25.0)

# PayPal checkout for a credit pack / plan — send buyer to res["url"]
res = billing.checkout("cus_123", "topup_1k")

# PayPal invoice for usage overage (paid -> webhook credits the wallet)
billing.create_overage_invoice("cus_123", 12.40)
```

## LiteLLM gateway hook

Point a stock LiteLLM proxy at MeterPal with two config lines:

```yaml
# config.yaml
litellm_settings:
  callbacks: ["meterpal.litellm_hook.instance"]
```

```bash
export PAB_API_KEY=am_sk_test_...
export PAB_BASE_URL=http://localhost:8080/v1
export PAB_REQUIRED_BALANCE=0.5     # headroom demanded by /check
export PAB_FAIL_MODE=closed         # production: refuse when billing is down
litellm --config config.yaml --port 4000
```

Every `/v1/chat/completions` is then pre-authorized against the caller's
wallet and metered after the call. The `user` field on the request (or the
`PAB_CUSTOMER_HEADER`) identifies the customer.

## Testing locally

```bash
# unit tests — httpx MockTransport, no server, no network
python -m pytest sdk/python/tests -q

# live: one metered call, one stream, one refusal, one paywall
export METERPAL_SECRET_KEY=$(grep '^PAB_API_KEY=' gateway/.env | cut -d= -f2)
export METERPAL_BASE_URL=http://localhost:8080
python sdk/python/scripts/live_check.py
```

`METERPAL_BASE_URL` is the billing server, not the gateway: the billing server
proxies `/v1/chat/completions` to the metered gateway, so the SDK only ever
talks to one host. The live check exits non-zero if any assertion fails, so it
is safe to run in CI.
