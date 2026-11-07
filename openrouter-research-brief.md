# OpenRouter: Business Model, Billing Controls, and Failure Modes — Research Brief

**Research date:** 2026-11-06 · **Method:** web_search + web_fetch against primary sources (OpenRouter docs/blog/terms/API, X via search index, HN). Catalog counts retrieved live from the OpenRouter public API at 2026-11-06T17:37Z.

> **Two honesty notes first.**
> 1. **The "Feb 2025 all models free" incident and the "Claude 3.7 Sonnet routing bug (~Feb 2025)" could not be verified.** OpenRouter's complete blog archive (RSS, back to Jan 2025) has no post for either; the Datadog status page returns 403 on all API endpoints. What *is* published is a **Feb 2026** double outage with a full postmortem (§5) — better control-failure material anyway.
> 2. **The "markup over provider cost" premise is outdated.** Current model is *zero inference markup + a fee on credit purchase* (§1).

---

## 1. Business model

**VERIFIED.** OpenRouter charges **no inference markup**; it earns a **platform fee on credit purchases**, collected up front.

| Plan | Platform fee | Models | Providers |
|---|---|---|---|
| Free | N/A | 25+ free | 4 free |
| Standard | **5.5%** | 600+ | 80+ |
| Business | **8%** | 600+ | 80+ |
| Enterprise | Custom discounts | 600+ | 80+ |

(https://openrouter.ai/pricing.md)

- "Inference is billed at the provider's list price on every plan. OpenRouter's fee is charged when you buy credits, 5.5% on Standard and 8% on Business, never on individual requests." (https://openrouter.ai/pricing.md)
- "We pass through the pricing of the underlying providers; there is no markup on inference pricing (however we do charge a fee when purchasing credits)." (https://openrouter.ai/docs/faq.md)

**Fee mechanics** (restructured 2025-06-09): removed the fixed $0.35 Stripe fee; non-crypto **5.5%, min $0.80**; crypto **5.0% flat, no minimum**. Published old→new totals: $5 $0.61→$0.80, $10 $0.88→$0.80, $25 $1.67→$1.38, $100 $5.61→$5.50, $1,000 $52.98→$55.00 — "Most users will see lower total costs." The same post announced the 5% BYOK fee would be replaced by a fixed monthly subscription, pricing TBD (https://openrouter.ai/blog/announcements/simplifying-our-platform-fee/).

**BYOK:** provider bills you directly; Standard/Business include **$25,000 list-price inference/month with no fee**, then **5% of equivalent list price** deducted from credits; Enterprise custom (https://openrouter.ai/docs/faq.md).

**Routers:** `openrouter/auto` adds **no fee** — "you pay the rate of whichever model serves the request." `openrouter/free` picks a free model at random (https://openrouter.ai/pricing.md, https://openrouter.ai/docs/guides/routing/routers/free-router).

**VERIFIED — catalog counts (live, 2026-11-06T17:37Z):** 453 models default (`/api/v1/models`); **697** with `?output_modalities=all`; **121 providers** (`/api/v1/providers`); 110 zero-priced models. OpenRouter's page claims "600+ models, 80+ providers" — the API exceeds both floors, and the 600+ claim only holds for the `output_modalities=all` variant.

**INFERENCE.** The page is a conservative floor ~40 providers stale. And because the fee is earned on the **cash receipt** rather than on inference, this is a working-capital business, not a reseller.

---

## 2. Price volatility

**VERIFIED — dispersion is a product feature, not an exception.** "DeepSeek is one model served by 16 different companies, at prices that vary by about **4x** and throughput ranging from **4 to 57 tokens per second**" and "We don't mark up provider pricing… so that spread is real provider economics, not our margin" (https://openrouter.ai/blog/insights/why-openrouter-for-deepseek/, 2026-07-13). DeepSeek V4.1 Flash: 23 endpoints at $0.12–$0.375/M input, $0.42–$1.50/M output — 3.1x/3.6x spread (https://flexprice.io/pricing-index/openrouter). Users control exposure via `max_price` and the `:floor` variant (https://openrouter.ai/docs/guides/routing/provider-selection.md).

**VERIFIED — policy: pass through, don't absorb.** Upstream price increases reach users directly. **Peak/off-peak pricing now reaches the catalog** — DeepSeek V4-Pro went to $0.66/M in–$1.98/M out off-peak and $1.32/M–$3.96/M out peak, a **2.3x–4.6x output increase** over the prior flat $0.435/$0.87, described as the first list-price rise by a major open-weights lab (https://www.stateof.ai/2025-state-of-ai-report.pdf, repricing dated 2026-08-16).

**VERIFIED — two exceptions to pass-through:** (a) when two providers went paid-only, OpenRouter "**will directly cover some of the associated costs**" to keep DeepSeek V3/R1 free (https://openrouter.ai/blog/announcements/updates-to-our-free-tier-sustaining-accessible-ai-for-everyone/, 2025-07-10); (b) free variants are withdrawn without notice — `qwen/qwen3-coder:free` and `deepseek/deepseek-r1:free` were delisted while paid versions stayed: "Treat a free model as a promotion with an end date you won't be told in advance" (https://www.truefoundry.com/blog/openrouter-free-models-whats-actually-free-and-what-it-costs-you).

**INFERENCE.** With zero markup, **OpenRouter has no buffer to absorb upstream hikes** — a provider price rise is an immediate user bill increase. The only material absorption mechanism is Zero Completion Insurance, which covers *failure*, not *price*. Cost exposure is a function of routing quality, not model choice.

---

## 3. Prepaid credits: mechanics, expiry, working capital

**VERIFIED — mechanics.** Credits are deposits, deducted per request from provider token usage. **Min/max purchase $5 / $25,000 per transaction** (https://openrouter.ai/terms §4.1). Auto top-up replenishes below a threshold (https://openrouter.ai/docs/faq.md). **Refund window 24 hours**, self-serve via a button on the Credits page; after 24h unused credits are non-refundable. **Platform fees non-refundable; crypto payments never refundable** (https://openrouter.ai/docs/faq.md). **Expiry: one year, reserved right** ("we reserve the right to expire unused credits after one year of purchase"). Deleting an account forfeits unused credits. Promo credits have no cash value, are non-refundable, and §4.1 rights don't apply (§4.3).

**VERIFIED — the 402.** Status **402**, code `payment_required`: "Your account or API key has insufficient credits." `error.metadata.limit_source` disambiguates three cases: `openrouter_credits` (balance short), `openrouter_key_limit` (per-key cap), `openrouter_in_flight_budget` (running requests filled the in-flight budget — **not** a balance problem). Only the in-flight case is retryable via `Retry-After`; "A 402 without the header is not a wait-and-retry case," and **no SDK retries 402 on its own** (https://openrouter.ai/docs/api/reference/errors-and-debugging.md, https://openrouter.ai/docs/api_reference/limits). Real-world text: *"This request requires more credits, or fewer max_tokens. You requested up to 1000 tokens, but can only afford 0."* (https://github.com/Aider-AI/aider/issues/3621). A **negative balance blocks free models** (https://openrouter.ai/pricing.md).

**VERIFIED — the working-capital answer, from an OpenRouter employee** (HN, ~Sept 2026; https://news.ycombinator.com/item?id=49660441):

> "We started actually expiring the credits a ~month ago. If you make any kind of API request, it resets the clock. We try to make it a very generous policy, but **we can't keep a monotonically increasing liability on the books. We end up owing (a lot) of taxes on it, but can't actually recognize revenue. We would much rather you spend the credits!** Hence the reminder emails, and generous 'clock reset' policy."

A commenter in the same thread: "They cant recognize balance topup as revenue because then they'll owe taxes on full amount." Another noted the reset-clock policy "is actually documented somewhere? Because right now your website it's just say 1 year since credit purchase."

**VERIFIED — fragility.** 2025-03-30: "Auto Top-up Outage - failed to credit users between midnight and 10:30am ET" (https://huggingface.co/datasets/MercilessArtist/thePerfectStorm).

**VERIFIED — complaints.** The HN thread is the substantive complaint: users report learning of expiry "by HN post and the business asks themselves why its reputation keeps taking hits." One recalled OpenRouter previously *not* expiring credits despite the terms — a policy change communicated informally, then enforced. The documented remedy is manual: support@openrouter.ai.

**INFERENCE.** The accounting is **cash in before cost out, revenue deferred**: a top-up is a liability, not revenue, until consumed. **Credit expiry is a revenue-recognition mechanism, not a courtesy** — and "clock reset on any request" converts a cliff into a usage-linked annuity, so expiry mostly hits dormant balances. Worth flagging: **OpenRouter charges 5.5% on the top-up but won't refund the fee, while the underlying balance can expire** — buy $10,000, use $100, leave, and you lose both $9,900 and ~$550.

---

## 4. Routing, fallbacks, ZDR, failed-request billing

**VERIFIED — provider routing API** (`provider` object; https://openrouter.ai/docs/guides/routing/provider-selection.md): `order` (try in order), `only`, `ignore`, `sort` (price/throughput/latency), `max_price` (cap what you'll pay), `require_parameters` (default false), `data_collection` (allow/deny), `zdr`, `allow_fallbacks` (default true), `quantizations`. Default load balancing "deprioritizes any provider that had a significant outage in the last 30 seconds and is biased toward cheaper providers, weighted by the inverse square of price." Variants: `:nitro` (throughput), `:floor` (price), `:exacto` (quality-first), `:free`, `:batch` (https://openrouter.ai/blog/insights/why-openrouter-for-deepseek/, https://openrouter.ai/docs/faq.md).

**VERIFIED — fallback:** "If a provider returns an error OpenRouter will automatically fall back to the next provider. This happens transparently to the user" (https://openrouter.ai/docs/faq.md).

**VERIFIED — ZDR tiers** (https://openrouter.ai/docs/guides/features/zdr.md): **ZDR** (no routine storage, no training); **Safety Retention** (may retain for abuse detection, flagged or not, no training); **Retention and Training**. Enforceable at five scopes (account, per-model-group, guardrail, per-request `provider.zdr`, BYOK declaration). Defaults differ: self-serve allows Safety Retention, **enterprise is ZDR-only**. **Google changed the rules 2026-10-18**: Vertex Google models now require Safety Retention, retaining flagged prompts up to 90 days; under strict ZDR "most Google models become unavailable." Conservative default: unascertainable policy is assumed to retain *and* train. In-memory prompt caching is **not** treated as retention. Known gap: ZDR "does not apply to plugins and tools… such as web search"; Web Search/Fetch tools and the Web Search plugin **reject the Firecrawl engine** under ZDR. CSAM screening across all traffic planned 2026-10-27.

**VERIFIED — failed/fallback attempts are NOT billed:**

> "Are failed or fallback attempts billed? No. An attempt that errors is not charged for its model tokens, so with fallback you pay only for the run that answers." (https://openrouter.ai/pricing.md)

**Zero Completion Insurance** (expanded from DeepSeek R1 to all models, **2025-03-25**): triggers on (a) zero completion tokens with blank/null finish reason, or (b) error finish reason. Covers prompt, completion, and reasoning tokens — "**no credits will be deducted from your account, regardless of provider charges to OpenRouter**." Auto-enabled, no configuration. Exclusions: auxiliary services that already ran (web-search fees, PDF/OCR, web fetch) may still be billed; TTS needs format-valid audio; empty/invalid image payloads are rejected as upstream failures and not billed (https://openrouter.ai/blog/announcements/never-pay-for-empty-ai-responses-again/, https://openrouter.ai/docs/guides/features/zero-completion-insurance). Failed attempts still count against free-tier daily caps, and a `:free` → paid fallback **is** billed (https://openrouter.ai/pricing.md, https://openrouter.ai/docs/guides/routing/model-variants/free).

**INFERENCE.** There is **no documented standalone "refund for failed requests" policy** — the design *preempts* it: failures aren't charged, so there's nothing to refund. But there's also **no documented remedy for bad-but-valid output** (degraded quality with a normal finish reason). Zero Completion Insurance covers *empty/error*, not *degraded*.

---

## 5. The documented billing/control failure

**VERIFIED — "OpenRouter Outages on February 17 and 19, 2026"** (published 2026-02-20, updated 2026-06-24; https://openrouter.ai/blog/announcements/openrouter-outages-on-february-17-and-19-2026/).

**What happened.** An external caching layer (API-key lookups) dropped all DB connections on **Feb 17 at 5:27 AM UTC**. Initially ~20% of requests failed with 500s. The cache recovered, but all cached entries had been invalidated, so every request needed a fresh DB lookup; the DB couldn't absorb the spike and **returned timeouts as 401 "User not found" errors**. A concurrent **DoS attack** was ramping, so OpenRouter initially blamed the DoS and shipped WAF rules. "When the same caching failure recurred on February 19th without an accompanying DoS, the true root cause became clear."

**Impact.** Feb 17: ~20% failures 5:27–5:40 UTC, then **80–90% failure 5:40–6:05 UTC** (38 min total). Feb 19: partial 7:36–7:42, near-total 7:42–8:11 UTC (35 min). Chatroom degraded both times. Feb 17 timeline: 5:20 errors begin (no user impact) → 5:27 cache drops → 5:28 internal alert → 5:40 401s begin → 5:50 DoS identified, WAF deployed → 6:05 restored.

**Why the 401s mattered.** "Returning an authentication error for what was actually an infrastructure problem caused real confusion: some customers spent time debugging their own API key configurations when nothing on their side was wrong."

**Remediations.** (1) **Circuit breakers** to limit blast radius and prevent the thundering-herd DB stampede by managing cache repopulation in a controlled way. (2) **Accurate error codes** — 503 instead of 401 for infrastructure-caused authorization failures. (3) **Provider-side fixes**. **Next:** "We will soon be rolling out a fallback caching mechanism that will make OpenRouter resilient to even extended downtime in the caching layer." Attribution stance: "delivering high availability systems with redundancy against failures in our dependencies is our responsibility, not theirs."

**VERIFIED — other control failures.** 2025-08-28: "OpenRouter Systems Inaccessible - upstream database dependency downtime in US East - 50 minutes total." 2025-06-12: global outage tied to Google Cloud then Cloudflare — OpenRouter's own tweets: "There's a global internet outage happening, affecting OpenRouter along with many other companies… Part of the reason appears to be Cloudflare-related," then "Update: incident appears to be related to Google Cloud," then "Seeing full recovery… (Hard to know when instrumentation is down as well!)" (https://x.com/OpenRouterAI/status/1933263905385500853). (https://huggingface.co/datasets/MercilessArtist/thePerfectStorm)

**VERIFIED — the provider-quality analogue.** Zero Completion Insurance (2025-03-25): "As the first and largest LLM router, we've seen virtually every possible quality issue from model providers… Starting today, when you get a response with no output tokens and a blank or error finish reason, you will not be charged, even if the underlying provider is still charging for prompt processing. At today's volume, this will save users over **$18,000 per week** across hundreds of models." It was "an expansion of our prior insurance coverage of DeepSeek R1 to all models." (https://x.com/OpenRouterAI/status/1904567846975201766, https://openrouter.ai/blog/announcements/never-pay-for-empty-ai-responses-again/) — the concrete case of OpenRouter **absorbing** rather than passing through, with its own cost figure.

**INFERENCE.** "All models free" is the natural lay description of "OpenRouter paid for everyone's inference and didn't bill you" — i.e. Zero Completion Insurance — my best explanation for the premise. Remediation across all documented incidents is consistent (circuit breakers, accurate error codes, provider-side fixes, post-hoc write-ups), but **no incident write-up mentions feature flags, canaries, or staged rollout**; the Feb 2026 postmortem says protections were "deployed within hours" once root cause was clear.

---

## 6. The Claude 3.7 Sonnet routing bug (~Feb 2025)

**NOT VERIFIED.** I found no primary-source evidence for the incident, the percentage, or any credit issuance — no blog post (complete RSS archive back to Jan 2025), no reachable status entry (403), no retrievable X statement. Reddit's API blocked me.

**VERIFIED context.** Claude 3.7 Sonnet shipped 2025-02-24 at $3/M in, $15/M out including thinking tokens (https://latent.space/p/ainews-legacy-25-02-24-ainews-claude-37-sonnet/). Extended Thinking was **not** on OpenRouter's API at launch — "Extended Thinking coming very soon to the OpenRouter API… There's a new endpoint on OpenRouter for thinking specifically" (https://github.com/danny-avila/LibreChat/discussions/6036); the `:thinking` variant is now deprecated (https://openrouter.ai/docs/guides/routing/model-variants/thinking).

**VERIFIED — real Claude 3.7 defects on OpenRouter, with no credit/refund action found:**
- **Missing thinking signatures:** "With Anthropic direct, you get back `provider_specific_fields.thinking_blocks` which include a signature" — absent via OpenRouter (https://github.com/BerriAI/litellm/issues/9255).
- **Bedrock failures:** "I continue to encounter the message 'Bedrock is unable to process your request' for several attempts when using Claude 3.7 sonnet, even after activating the retry feature" (https://www.reddit.com/r/ClaudeAI/comments/1ix1zv3/more_details_on_claude_37_sonnet/).
- **Thinking content silently dropped:** the Claude 3.7 thinking box disappeared and reappeared after **excluding the route in OpenRouter account settings** — "I guess it's because Bedrock itself doesn't return reasoning content?" (https://github.com/RooCodeInc/Roo-Code/issues/2910).

**VERIFIED — closest credit event.** Zero Completion Insurance (2025-03-25) covers exactly this failure class (empty/error finish reasons — the signature of a broken reasoning endpoint) and applied to Claude 3.7, but the remedy is **prospective non-deduction, not a retroactive credit**.

**INFERENCE.** If a Claude 3.7 routing bug produced bad output with a **valid** finish reason, Zero Completion Insurance would **not** apply — it requires zero completion tokens or an error finish reason — so it would have been billed with only a manual support request as recourse. **The "10% of users" figure appears in no source I could reach; treat it as unverified and don't cite it externally.**

---

## 7. Refunds, credits, enterprise invoicing at scale

**VERIFIED — self-serve tooling.** Refunds: self-serve button on the Credits page, 24h window, unused amount returned, fee non-refundable, crypto never refundable. `GET /api/v1/credits` (management key required) returns `total_credits` / `total_usage`. `GET /api/v1/key` returns `limit_remaining`, `budgets`, `effective_budget` for proactive monitoring. Management API keys gate `/api/v1/keys`, workspace members, budgets. Activity page filters by model, provider, API key. Budget enforcement order: guardrail budgets → workspace budgets → per-key limit, checked on every paid request; windows reset 00:00 UTC daily / Monday / 1st monthly; lifetime workspace budgets never reset. (https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits.md, https://openrouter.ai/docs/api_reference/limits, https://openrouter.ai/docs/guides/overview/auth/management-api-keys.md)

**VERIFIED — no documented dispute process.** No published "billing dispute" or "I was overcharged" process exists. The only documented channel is email **support@openrouter.ai**; bugs go to Discord (https://openrouter.ai/docs/faq.md).

**VERIFIED — the one public precedent.** On an OpenCode key breach (balance showing −$563), the COO's response: "As the COO of OpenRouter, I've just requested my team to investigate… We have recently updated our default API keys to include limitations and expiration dates… we've rolled out new automated tools for detecting leaks. However, it's not foolproof yet." (https://www.reddit.com/r/openrouter/comments/1x7agpv/my_account_shows_563/) The community's workaround: contact support, give pre-incident balance/timeframe/key ID, and **ask them to waive the negative balance** — a discretionary negotiation. Compounding it: a negative balance **blocks free models** until credits are added.

**INFERENCE.** Incident credits are a **manual, discretionary, out-of-band** process — no API, no policy, no SLA. Zero Completion Insurance is the strategic answer: rather than refunding after the fact, OpenRouter **structurally prevents the charge** for failure classes it can detect. That's the pattern worth copying.

---

## 8. Replicate comparison

**VERIFIED — billing.** Unit of sale is **GPU-seconds**: "Most models are billed by the time they take to run. The price-per-second varies according to the hardware in use" (https://replicate.com/pricing). **Public models:** "you only pay for the time it's active processing your requests. Setup and idle time for the model is free." **Private models/deployments:** you pay for **all** time instances are online — setup, idle, and active (fast-booting fine-tunes excepted). Token/image/video pricing also exists: `deepseek-ai/deepseek-r1` $0.01/thousand output tokens, $3.75/M input; video per second of output. Hardware: CPU (Small) $0.000025/sec ($0.09/hr); GPU 2GB $0.000100/sec ($0.36/hr); A100 80GB $0.001400/sec ($5.04/hr); 2x A100 $0.002800/sec ($10.08/hr).

**VERIFIED — prepaid credit.** "To use Replicate, you must first purchase credit upfront. We'll deduct your usage from your credit balance as you go… **Purchased credit is valid for 1 year from the purchase date and is not refundable.**" Auto reload: **min threshold $5, min reload balance $15**. At zero balance, "we will prevent any new work from starting and shut down any infrastructure we're running for you. In rare cases, a prediction may run over your credit balance. In these instances, we'll automatically charge your default payment method at the end of the month for the outstanding balance." (https://replicate.com/docs/topics/billing/prepaid-credit.md) Arrears billing also exists, with early charges when limits are first crossed (https://replicate.com/docs/topics/billing.md).

**VERIFIED — failed/retried predictions.** "For all models, **if a run fails, we don't charge you.** If you cancel a run for an official model, you may still be charged. For models that charge based on time, we charge you for the time it ran up until that point. **For private models and deployments, failed and canceled runs are billed for the time the instances they ran on were active**, as normal." For compound models: "If the model fails, you will be billed for the duration of the run, plus the cost of the downstream models that were called before the failure occurred." (https://replicate.com/docs/topics/billing.md)

| Case | OpenRouter | Replicate |
|---|---|---|
| Failed/erroring attempt, public model | Not charged | Not charged |
| Cancelled run | Not charged (errored attempts) | **May be charged** (elapsed time) |
| Failed run, private model / deployment | Not charged | **Billed for active instance time** |
| Failure of a model calling other models | Not charged | **Billed for run + downstream models** |
| Failed attempt counts against rate limits | **Yes** (free-tier cap) | Not documented |

**VERIFIED — what I could NOT find.** No documented Replicate policy on double-billing of retried predictions, and I could not confirm a complaint thread (Reddit blocked). **Treat "Replicate has a documented double-billing problem" as unverified**; the structurally plausible double-charge path is the documented one — a failed run on a private model, deployment, or compound model.

**INFERENCE.** Replicate's exposure sits where a failure still consumed the GPU; OpenRouter's sits in provider prompt-processing charges on empty responses. Both reach for *don't bill for a failed run*, but Replicate applies it only where no scarce resource was consumed. Replicate's **1-year non-refundable prepaid credit** is near-identical to OpenRouter's **1-year expiry + 24h refund window**, including the overrun-and-charge-the-card gap — a pattern that looks industry-wide, not OpenRouter-specific.

---

## Key quotes

1. **Margin:** "Inference is billed at the provider's list price on every plan. OpenRouter's fee is charged when you buy credits, 5.5% on Standard and 8% on Business, never on individual requests." — https://openrouter.ai/pricing.md
2. **Working capital (OpenRouter employee, HN):** "we can't keep a monotonically increasing liability on the books. We end up owing (a lot) of taxes on it, but can't actually recognize revenue. We would much rather you spend the credits!" — https://news.ycombinator.com/item?id=49660441
3. **Failed requests:** "Are failed or fallback attempts billed? No. An attempt that errors is not charged for its model tokens, so with fallback you pay only for the run that answers." — https://openrouter.ai/pricing.md
4. **Absorbed cost (OpenRouter's own figure, Mar 2025):** "…you will not be charged, even if the underlying provider is still charging for prompt processing. At today's volume, this will save users over $18,000 per week across hundreds of models." — https://openrouter.ai/blog/announcements/never-pay-for-empty-ai-responses-again/
5. **Fail loudly (Feb 2026 postmortem):** "Returning an authentication error for what was actually an infrastructure problem caused real confusion: some customers spent time debugging their own API key configurations when nothing on their side was wrong." — https://openrouter.ai/blog/announcements/openrouter-outages-on-february-17-and-19-2026/
6. **Blast-radius control:** "We have implemented circuit breakers that detect caching layer failures and limit their blast radius." — same postmortem
7. **Refunds:** "Refunds for unused Credits may be requested within twenty-four (24) hours… If no refund request is received within twenty-four (24) hours following the purchase, any unused Credits become non-refundable." — https://openrouter.ai/docs/faq.md · https://openrouter.ai/terms §4.1
8. **Provider dispersion:** "DeepSeek is one model served by 16 different companies, at prices that vary by about 4x… so that spread is real provider economics, not our margin." — https://openrouter.ai/blog/insights/why-openrouter-for-deepseek/
9. **Replicate failures:** "For all models, if a run fails, we don't charge you… For private models and deployments, failed and canceled runs are billed for the time the instances they ran on were active, as normal." — https://replicate.com/docs/topics/billing.md

---

## Evidence gaps — verify before citing

| Claim | Status | Action |
|---|---|---|
| "All models free," Feb 2025 | **NOT FOUND** | Likely conflates Zero Completion Insurance (Mar 2025) or the `:free` mechanism. Check OpenRouter Discord (discord.gg/openrouter) archive directly. |
| Claude 3.7 routing bug + credits + "10% of users" | **NOT FOUND** | The % and credit mechanism are unverified. Closest documented analogue: Zero Completion Insurance coverage. |
| Feature flags / staged rollout after incidents | **NOT FOUND** | Published postmortems describe deploying "within hours," not flag-based rollouts. |
| Documented Replicate double-billing complaint | **NOT FOUND** | Reddit API blocked me. The structurally plausible path (failed run on private model/deployment/compound model) **is** documented. |
| OpenRouter enterprise invoicing terms | **PARTIAL** | Enterprise = fee discounts, custom BYOK allowances, invoice-billed accounts (excluded from the in-flight budget). Contracts aren't public. |
| OpenRouter revenue / volume | **NOT FOUND** | No public financials. ClickHouse's partner blog cites 1B+ requests/day, 110T tokens/week, 19.7B monthly requests (Aug 2026), 500+ models / 80+ providers — https://clickhouse.com/blog/openrouter-llm-routing-observability-clickhouse-cloud |
