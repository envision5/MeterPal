# MeterPal Commercial License

MeterPal is dual-licensed.

## Open source license (default)

MeterPal-authored code is available under the **GNU Affero General Public
License, Version 3** (see [`LICENSE`](LICENSE)). You may use, modify, and
distribute it under those terms, including commercially — provided you comply
with the AGPL, which requires that:

- if you distribute the software, or
- if you make it available to users over a network,

you make the complete corresponding source code of your modified version
available under the same license.

For many teams that requirement is exactly what they want. For others it is
not, which is what this document is for.

## Commercial license (alternative)

A commercial license is available for organizations that want to use
MeterPal-authored code **without the AGPL's source-disclosure obligations** —
for example, embedding it in a closed-source product, or operating a hosted
service where you do not wish to publish your modifications.

A commercial license typically grants:

- the right to use, modify, and distribute MeterPal code in proprietary
  products, without releasing your source
- the right to offer it as a hosted or managed service without triggering
  AGPL §13
- terms negotiated for your organization (support, warranty, indemnity)

Commercial terms are negotiated per organization. **Contact
`licensing@meterpal.dev`** to discuss.

## What a commercial license does NOT cover

This is important: MeterPal vendors two third-party codebases, and this
commercial license grants **no rights whatsoever** in them.

| Component | Origin | License | Governed by |
| --- | --- | --- | --- |
| `billing/` | Autumn fork | Apache-2.0 | [`billing/LICENSE`](billing/LICENSE) |
| `gateway/` | LiteLLM | MIT | [`gateway/LICENSE`](gateway/LICENSE) |

Those are permissive licenses and impose no source-disclosure obligation on
you, so in most cases they raise no issue. If you need terms for them, you
must obtain them from their respective copyright holders. See [`NOTICE`](NOTICE)
for full attribution.

The upstream LiteLLM `enterprise/` package is **not** distributed in this
repository, so no BerriAI enterprise license is required to use what is here.

## Hackathon note

This project was submitted to the [PayPal AI Hackathon
2026](https://paypalaihackathon.devpost.com/). The public repository remains
fully open source under the AGPL-3.0; the commercial option above is a
separate arrangement and does not restrict, gate, or remove any functionality
available to the public or to hackathon judges.

---

*This document is a licensing overview, not a contract, and is not legal
advice. Commercial terms are established only by a signed agreement.*
