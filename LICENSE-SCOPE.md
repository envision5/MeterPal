# License scope — which code carries which license

MeterPal is a dual-licensed project built on two vendored open-source
codebases. This file maps every path in the repository to its license.
The canonical license texts live in the files listed below.

## MeterPal-authored code — AGPL-3.0

Everything MeterPal wrote is licensed under the **GNU Affero General Public
License, Version 3** — see [`LICENSE`](LICENSE).

| Path | What it is |
| --- | --- |
| `sdk/` | `@meterpal/sdk` (TypeScript) and `meterpal` (Python) client SDKs + CLI |
| `agent/` | MCP server and the merchant/buyer demo agents |
| `demo/` | Mock providers, bootstrap seeding, the scripted billing walkthrough |
| `demo-app/` | The storefront demo application |
| `docs/` | Documentation |
| `scripts/` | Repository tooling |
| `docker/` | Local infrastructure definitions |
| `assets/` | Project artwork |

plus MeterPal's own integration layers inside the vendored trees:

- the PayPal adapter under `billing/server/src/external/paypal/`
- the LiteLLM usage-billing hook
  (`gateway/litellm/integrations/meterpal_billing.py`)
- webhook signature verification
- MeterPal's database migrations

A commercial license is available for MeterPal-authored code only — see
[`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md).

## Vendored code — keeps its upstream license

These are **not** relicensed by MeterPal. Their licenses permit inclusion in
this project, and permit you to use them under their own terms.

| Path | Origin | License | Text |
| --- | --- | --- | --- |
| `billing/` | [Autumn](https://github.com/useautumn/autumn) fork | Apache-2.0 | [`billing/LICENSE`](billing/LICENSE), [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) |
| `gateway/` | [LiteLLM](https://github.com/BerriAI/litellm) fork | MIT | [`gateway/LICENSE`](gateway/LICENSE), [`LICENSES/MIT.txt`](LICENSES/MIT.txt) |

Upstream LiteLLM's `enterprise/` package is proprietary (BerriAI Enterprise
License, paid seats) and is **not distributed** in this repository — every
import of it is guarded by `try/except ImportError`. See [`NOTICE`](NOTICE)
for full attribution.
