# meterpal (Python)

Python client for **MeterPal** — the PayPal-native AI usage-billing gateway —
plus the LiteLLM usage-billing hook.

## Install

```bash
pip install meterpal            # client (httpx only)
pip install "meterpal[litellm]" # + gateway hook re-export
```

Or from this repo: `pip install -e sdk/python`.

## One import: metered inference

Swap `from openai import OpenAI` for `from meterpal import create_meterpal`
and every call is admitted, metered and charged to the end user — the same
`chat.completions` shape their app already speaks:

```python
from meterpal import create_meterpal, InsufficientBalanceError

meterpal = create_meterpal(api_key="am_sk_test_...")   # server-side only

try:
    completion = meterpal.chat.completions.create(
        model="custom/demo-gpt",
        messages=[{"role": "user", "content": "hi"}],
        user="cus_123",        # the end user being billed
    )
    completion["meterpal"]["credits_charged"]   # what it cost
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

## Billing client quickstart

```python
from meterpal import MeterPalClient

billing = MeterPalClient(
    secret_key="am_sk_test_...",
    base_url="http://localhost:8080/v1",
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

## Tests

```bash
pip install -e "sdk/python[dev]"
pytest sdk/python/tests -q
```
