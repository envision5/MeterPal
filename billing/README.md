# billing/ — the MeterPal billing core

This directory is the heart of MeterPal: the billing server (wallet ledger,
catalog, per-org PayPal), the merchant dashboard, and the hosted checkout. It
is an Apache-2.0 fork of [Autumn](https://github.com/useautumn/autumn) (upstream
went private 9/2026) with its Stripe rail removed and replaced by PayPal:
**Orders v2** for credit packs, **Subscriptions** for plans, **Invoicing** for
overage, and signature-verified webhooks that grant entitlements the moment
money lands. The fork lineage and everything built on top of the baseline are
recorded in the root [`README.md`](../README.md) and [`CHANGELOG.md`](../CHANGELOG.md).

## What lives here

| Path | What it is |
|---|---|
| `server/` | The billing server (:8080): wallet ledger with atomic admission control, catalog v2, the per-org PayPal adapter, webhook routes, the `/check` + `/track_tokens` metering contract, and the OpenAI-shaped inference proxy (`POST /v1/chat/completions`) |
| `shared/` | Models, API contracts and API versioning shared by server and dashboard |
| `vite/` | The merchant dashboard: catalog, the served-models price sheet, the PayPal integration panel, customer wallets, agents |
| `apps/checkout/` | The hosted checkout app behind PayPal approval links |
| `scripts/` | DB migrations (`bun db`), dev launchers, test tooling |
| `packages/autumn-js/` | The client library (npm `autumn-js`) used by `@meterpal/sdk` and the dashboard — the upstream package name is kept for compatibility |
| `packages/agent-docs/`, `packages/atmn/`, `packages/sdk/`, … | Upstream Autumn packages retained because workspace tooling still compiles against them |

## Run it

The canonical run instructions are the root [`README.md`](../README.md)
quickstart and [`docs/DEPLOY.md`](../docs/DEPLOY.md). Short form:

```bash
docker compose up -d                 # from the repo root: 2× Postgres + 2× Redis
cd billing && bun install            # workspace install
# configure + migrate (see ../docs/DEPLOY.md), then:
cd server && bun src/index.ts        # :8080
```

## Upstream material

Parts of the Autumn tree remain that MeterPal neither runs nor documents —
`apps/docs` (the Mintlify docs site), `apps/website`, `apps/sdk-test`,
`packages/atmn*` (the pricing-as-code CLI and its tests), `packages/ax-evals`,
`packages/render`. None of them are on the demo path. Upstream Autumn's own
product README, self-hosting notes and cloud branding used to live here and
have been replaced by this file.
