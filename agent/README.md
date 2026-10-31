# MeterPal agent layer

Two pieces:

1. **`mcp/server.ts`** — an MCP server that exposes the merchant's AI-billing
   workflow as tools for any MCP-capable agent (Claude Desktop, OpenAI agent
   SDK, LangChain, Cursor...).
2. **`merchant_demo.py` / `buyer_demo.py`** — the two agentic-commerce demos
   from the submission video.

## MCP server

Tools (thin wrappers over the MeterPal billing API; the secret key never
leaves this process):

| Tool | What it does |
|---|---|
| `meterpal_get_customer` | balance, plan, PayPal payment status |
| `meterpal_get_customer_usage` | credits spent + per-model breakdown (events ledger) |
| `meterpal_list_low_balance_customers` | the outreach list |
| `meterpal_grant_credits` | wallet top-up / compensation |
| `meterpal_create_overage_invoice` | PayPal Invoicing — paid invoices credit the wallet via webhook |
| `meterpal_create_checkout_link` | PayPal checkout (credit pack or plan) approval URL |

Run it:

```bash
cd agent && bun install
METERPAL_SECRET_KEY=am_sk_test_... bun mcp/server.ts
```

Wire into Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "meterpal": {
      "command": "bun",
      "args": ["/path/to/MeterPal/agent/mcp/server.ts"],
      "env": { "METERPAL_SECRET_KEY": "am_sk_test_...", "METERPAL_BASE_URL": "http://localhost:8080/v1" }
    },
    "paypal": {
      "url": "https://mcp.paypal.com/sse",
      "env": { "PAYPAL_ACCESS_TOKEN": "<sandbox token>", "PAYPAL_ENVIRONMENT": "SANDBOX" }
    }
  }
}
```

The `paypal` entry is PayPal's own remote MCP server (`mcp.paypal.com`) —
compose it with `meterpal` and the agent can both manage MeterPal billing and
search PayPal transactions / manage subscriptions natively.

## Merchant demo

```bash
export METERPAL_SECRET_KEY=am_sk_test_...   # same key as the gateway
python agent/merchant_demo.py               # scripted: no LLM key needed
python agent/merchant_demo.py --llm         # OpenAI-compatible function calling
```

Scripted mode performs the exact tool sequence an LLM chooses — low-balance
list → per-model usage → PayPal overage invoice — so the flow is verifiable
without any model key.

## Agent-as-buyer demo

```bash
export METERPAL_SECRET_KEY=... LITELLM_MASTER_KEY=...
python agent/buyer_demo.py
```

The loop: gateway **402** (refused before the provider is touched) → the agent
creates a PayPal order itself → the buyer approves in the sandbox popup (real
consent) → `PAYMENT.CAPTURE.COMPLETED` webhook credits the wallet → the agent
retries and succeeds. Human involvement is exactly one PayPal approval; every
billing action is the agent's.
