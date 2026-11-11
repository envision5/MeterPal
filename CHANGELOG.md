# MeterPal Changelog

All notable changes to MeterPal. Dates use 2026.

## [Unreleased] — built during the PayPal AI Hackathon submission period (2026-10-01 → 2026-11-12)

Everything from `0.1.0-baseline` onward is new work performed during the
hackathon submission window: the PayPal payment rail (Subscriptions catalog,
checkout, PayerID linking, Invoicing), the MeterPal SDKs (TypeScript + Python),
the agent layer (MCP server + demos), the end-user demo app, demo retooling,
documentation, and packaging.

**Judge's-chair fixes (2026-11-11)** — seven defects found by driving the running
stack as a judge would, all fixed:

- **The AG Grid beat 402'd on a fresh clone.** `bootstrap.py` seeded the console
  wallet (`meterpal-console`) from `demo-starter`, which grants 3 credits, while
  admission reserves a turn's worst case — input plus the output cap at the org's
  rates. After `custom/agnes-2.5-flash` was repriced to $200/M in / $800/M out
  that reservation became 7.5–10.4 credits, so the first studio prompt was
  refused and the "agent builds a widget" beat died before it started. The
  console wallet now gets its own grant (`CONSOLE_CREDITS`, 250) through
  `POST /v1/customers/meterpal-console/balances`, and `handleStudioAi.ts` sends
  `max_tokens` (`STUDIO_MAX_OUTPUT_TOKENS`, default 2048) so a turn reserves
  ~2 credits instead of ~10. The 8192-token default was a reservation bound, not
  a bill: the charge is still the tokens actually used.
- **The 402 did not state what it required.** The gateway's refusal carried
  neither the balance nor the requirement, so `InsufficientBalanceError`
  substituted `ADMISSION_FLOOR_CREDITS = 0.5` and the paywall told the customer
  they had *more* than enough while refusing them ("balance 2.23 / needed 0.50").
  `_billing_check` now returns the refusal's own numbers — `balance.remaining`
  and `pricing.estimated_cost` from the billing server's `/check` — and the
  gateway puts them in the 402 as `balance` / `required_credits`. The SDK reads
  them from either the OpenAI-shaped `error` or a FastAPI `detail`, and the
  paywall renders the real figure or none at all rather than a guess.
- **The Agent tab said "Agent off" while the agent was buying.** `/api/agent-settings`
  read only the per-customer `metadata.buyer_agent_mandate`, but the agent acts on
  `resolveBuyerMandate()`, which falls back to the merchant's standing terms. The
  panel showed empty budgets while the agent auto-approved a $10 purchase against
  a $15 line. The endpoint now returns the resolved mandate plus
  `mandate_source`, the panel labels inherited terms as inherited, and
  `/api/wallet`'s `mandate_enabled` (the pre-open decision) uses the same
  resolution.
- **The customer Usage ledger listed internal holds as requests.** A metered call
  writes a reservation, its release and the charge; the panel aggregated all
  three, so 33 of 50 rows had no model, `0 / 0` tokens and a negative charge, and
  the by-model table had an "other" bucket worth −6.55 credits. The events API now
  returns `idempotency_key` — the codebase's existing charge discriminator — and
  the panel keeps only charges. It also stops presenting one page as the month:
  when the window holds more than the page, the heading says so.
- **Agent-placed widgets landed on the KPI tiles.** AG Studio's layout repair
  re-places rather than rejects, and a re-placement can collide again; the agent
  reported "no overlaps detected" either way. `studioLayout.ts` repairs the page
  after every state write — overlapping non-seed widgets move below the content,
  seed widgets never move, and the pass is idempotent — and the page/widget agents
  are now given explicit placement rules and the `complete_task` contract
  (`summary` **and** `artifacts`), which is why a delegated run used to finish
  "without a summary".
- **PayPal's SDK threw on a loop during the money beat.** `TopUpModal` keyed its
  buttons effect on `inPageCheckout`, an inline literal the demo app rebuilt on
  every wallet poll, so the effect tore the buttons down and rebuilt them every
  ~2.5s — and each teardown removed the container PayPal's fields were mounted in
  ("Detected container element removed from DOM", uncaught). The callbacks live in
  refs now and the effect keys on the client id, so the buttons render once per
  checkout. The pack list is also hidden once a pack is chosen, instead of sitting
  beside the PayPal button inviting a second order.
- **The webhook claim was untrue on a laptop.** `PAYPAL_WEBHOOK_ID` was unset, so
  credits landed through the demo app's capture poll, not a webhook.
  `bootstrap.py` now reads PayPal settings from `billing/server/.env` as well as
  the shell (a shell-only read is why the step was skipped even after connecting
  PayPal), writes the resulting id back, and says plainly what to do when there is
  no public URL. The README says which path a localhost run is.

**Payments stay manual, on purpose.** The buyer agent can size a pack, open a
PayPal checkout and hand it over; it cannot approve one. That is the property the
money loop is built around, and the paywall card now says so — and names the
sandbox buyer account (`DEMO_PAYPAL_BUYER`) so the one manual click is not
guesswork.

**Six more defects the live re-test exposed (2026-11-11)** — each found by
re-driving the same beats in a browser after the fixes above, none of them
visible from reading the code:

- **The in-page PayPal capture could never settle.** `TopUpModal`'s
  `pollFinalize` — the callback that turns an approved order into credits when no
  webhook can reach `localhost` — fetched `/api/paypal/poll` with no customer
  token, so the route answered 401 on every tick. The modal then sat on "Payment
  not confirmed yet" while the money had already moved. It sends
  `authHeaders(customerId)` now. The capture proxy had the mirror problem in the
  other direction: `POST /api/paypal/capture/:orderId` accepted an order id from
  anyone, so it now goes through `requireCustomer` like every other money route.
  Verified: poll answers `{"status":"pending"}` with a token and 401 without.
- **The Usage ledger's arithmetic looked broken.** A demo turn costs ~0.0052
  credits, and the table printed two decimals everywhere: three rows of `0.01`
  under a total of `0.02`. `formatCredits` scales its precision to the magnitude
  (4 decimals below 0.01) and a `Total` row appears whenever more than one model
  is listed. Verified live: `0.0052 × 3`, total `0.0155`.
- **The studio header lost its subject in an empty org.** `selectedCustomer?.name
  ?? customerId ?? "the customer"` never falls back when `customerId` is `""`,
  which is exactly what an org with no customers passes, so the line read "never
  's wallet". Falls back on emptiness, not nullishness.
- **The top-up modal still asked the buyer to choose after they had chosen.**
  The pack list is hidden once a pack is picked, but the subtitle kept saying
  "Choose a credit pack" over a PayPal button. It switches to the approval
  instruction with the packs.
- **The paywall named a sandbox account that does not exist.** The hint was
  built around `DEMO_PAYPAL_BUYER`, and there is no buyer credential in this
  repo — so an unconfigured run told the viewer to "approve it in PayPal" and
  left them at a login wall. The card now adds the path that always works in the
  sandbox (the "Pay with Card" tab and its test card), and only shows the account
  name when the operator has actually set one.
- **Half the storefront's alerts were near-black on near-black.** The palette is
  dark unconditionally (`:root` sets a 5% background), but Tailwind's `dark:`
  variants keyed off the media query, so on a light-mode OS every
  `text-emerald-900 dark:text-emerald-100` pair rendered in its light-host shade
  — including "Your agent opened PayPal automatically", the one instruction the
  viewer has to read. `tailwind.config.cjs` now uses `darkMode: "class"` and
  `index.html` sets `class="dark"`, which also fixes the SDK components bundled
  into the demo (`CreditsBadge`, `LowBalanceBanner`) without giving up their
  light-host support.

**Metering chip now reconciles with the charge (2026-11-11)**
- A settled call reported only the *uncached* input and the *non-reasoning*
  output in `meterpal.input_tokens` / `output_tokens`, because that is how the
  ledger stores its pools. The demo chip prints those counts beside the charge,
  so a correct charge looked wrong: 40 in / 475 out at $200/$800 reads as
  $0.388, while the call (296 prompt tokens, 256 of them cached, plus 27
  reasoning tokens) really cost $0.4608. The block now reports the totals the
  charge was computed from, and names the cached / reasoning parts separately;
  `input_tokens × input_rate + output_tokens × output_rate` reproduces
  `credits_charged` exactly. The SDK's usage table adds the pools back the same
  way. Verified against a live call: 300 in / 180 out, 256 cached, 33
  reasoning → 0.204 credits.

**Checkout order-reuse fix (2026-11-08)**
- The one-live-order reuse branch matched the customer's latest pending intent
  regardless of which product the new checkout was for, so a top-up could
  surface the approval link of a different, still-pending pack. Reuse is now
  scoped to the requested product; mismatched pendings fall through to the
  fresh-mint path, whose `abandonOtherIntents` keeps the one-live-order
  invariant. Verified against the sandbox: a same-product checkout reuses the
  pending order (same token); a different pack abandons it and mints its own.

**The agentic loop (2026-11-07)**
- Sales-rep agent (merchant side): one agnes-flash call per turn, grounded in a
  precomputed context built from the events ledger (month spend, burn/day,
  days-to-empty, anomaly flag) and the merchant's catalog packs. Replies in
  prose, or a single fenced JSON action when the terms have settled, and
  degrades to a deterministic reply built from the same numbers if the model is
  unreachable. `usageInsights.ts` is the one implementation of the spend math —
  shared by the agent, the demo app and the dashboard — so every projection a
  customer sees is arithmetic over real event rows, not a model guess.
- Approvals inbox and spend alerts (dashboard): the merchant can act on what
  the agent drafts. A session-auth approvals inbox lists pending proposals with
  the math and the capped negotiation transcript, and one click mints the plan.
  A live "Unusual spend" section reads the same ledger anomaly rule the agent
  uses.
- Buyer agent bounded by a customer mandate (demo app): on a 402 the buyer
  agent consults a pure, unit-tested decision policy — initiate a PayPal
  checkout at or under the customer's auto-approve line, ask via a top-up
  authorization proposal above it, or deny when the monthly budget or the caps
  exclude every pack. PayPal's own approval screen stays the human gate on the
  money in every path (8 policy test cases).

**The demo app and the SDK (2026-11-07)**
- Tabbed wallet rail: Wallet, Agent, Offers and Usage become tabs instead of a
  stacked column, and the paywall moment renders as a first-class card inside
  the conversation — the refused call, the buyer-agent decision (initiated /
  waiting for approval / stood down), the balance, the shortfall and the pack
  it picked. Metered turns now carry input/output token counts so the metering
  cost is legible next to the charge.
- Python SDK inference client: swap one import for another and every call is
  admitted, metered and charged to the end user, with the paywall surfaced as a
  typed error that can open a PayPal checkout. The secret key stays
  server-side; a per-customer virtual key is minted and cached on first use.
- The metered path is demoable end to end: legacy checkout maps `product_id`
  onto `plan_id` so SDK `topUp()` and the buyer agent stop 404ing; the smoke
  test tops its test user back up below the balance floor; Tinybird-not-
  configured is a typed 503 instead of a raw throw; onboarding status falls
  back to the Postgres event ledger; free-plan gateway ceilings raised to
  survive a real agentic burst.
- The LiteLLM bridge falls back to reading `gateway/.env` directly when the
  launcher did not export it, so a bare `litellm --config` does not start the
  bridge disabled (`PAB_ENV_FILE=0` opts out).

**Concurrency judge-proofing (2026-11-07)**
- `DEP_FAILURE_POLICY` toggle: fail-closed 503 shedding for the idempotency
  claim, rate limiter and check fail-open surfaces; queue permits stay
  fail-open (throughput cap, not correctness).
- `SERVER_FLEET_SIZE` pinned into cluster forks; the full-subject gate divider
  derives from the real fork count instead of the per-process default.
- Cron multi-instance safety: `withSingleFlight` tick-overlap guard,
  `FOR UPDATE` claim on invoice voids, status-conditioned exactly-once claims
  for trial/revert/one-off expiries.
- Load-test rig: setup seeding 4 plans + 500 customers, stress config, results
  summarizer; the advisory plain-check invariant and the scaling story are
  documented in `docs/scaling-and-concurrency.md`.

**Stripe removal (2026-11-04)**
- The Stripe provider is deleted from the fork — server internals, tests,
  shared models, dashboard views, SDK endpoints — and `stripe_webhook_events`
  is renamed to the durable `webhook_events` table. MeterPal is
  PayPal-exclusive.

**The portal, setup wizard and the init CLI (2026-11-04)**
- The customer portal, the merchant setup wizard, PayPal refunds and overage
  invoices, PayPal auto-top-up, and the served-model deployment service with
  its migrations.
- `meterpal init`: the framework-detecting CLI that writes the integration for
  the developer's app, so nobody has to work out how to wire a payments rail in
  by hand. It ships from this repo — it is not on npm yet.
- Local DB role names kept stable, `docker-compose.yml` / `.env.example` files
  / demo scripts aligned with the billing/gateway split, and `docs/DEPLOY.md`
  rewritten from the Stripe-era guide to a PayPal-native one.

**PayPal subscription switch — end to end (2026-11-02)**
- The plan switch now completes the whole PayPal loop: click → a real PayPal
  subscription on the merchant's plan → buyer approves → the browser returns
  → the plan is attached with its allowance. Verified against the PayPal
  sandbox, including the buyer-facing approval.
- PayPal is the authority for subscription state; the DB flag is no longer
  trusted. Repeat clicks reuse the pending approval instead of minting an
  orphan subscription; paid→paid plan changes revise rather than double-bill;
  cancellation sends the `reason` PayPal requires.
- Post-approval redirect resolution: PayPal redirects with the express-checkout
  token of the order it created for the approval, not the BA- token from the
  approval link. The return route now carries a MeterPal-minted checkout token
  in the return URL and resolves the subscription through it, with a
  payer-match fallback for links created earlier.
- Free plans (no recurring price) downgrade correctly: the paid PayPal
  subscription is cancelled and the plan is applied locally, with no checkout.
- Approval intents settle on activation instead of staying `pending`.

**LiteLLM bridge (2026-11-02)**
- Fixed the drizzle column names in `internal/keys/litellmKeys.ts`
  (`customers.litellm_virtual_key`, `bridge_audit_log.customer_id` /
  `.litellm_key_hash`); the camelCase properties were `undefined`, so no
  customer ever received a virtual key.
- LiteLLM key aliases are unique: an orphaned key (customer deleted and
  recreated) is now deleted and re-minted instead of failing forever.

**Architecture spec (2026-11-02)**
- `docs/architecture.md` — the merchant-facing product design: multi-tenant
  PayPal, the served-model and cost catalog, the shared metered gateway, the
  OpenAI-compatible SDK client, the install/CLI step, the onboarding wizard,
  the data-model and API changes, tenant-isolation requirements, and a phased
  rollout with acceptance criteria.

**Live metering (2026-11-02)** — P0 of the architecture plan
- The gateway now runs with its configuration in the environment, so the
  MeterPal bridge is actually enabled. Inference calls are metered again:
  a call through `:4000` debits the customer's wallet (verified in the
  browser — a chat message shows up in "Recent requests" and the credit
  balance drops).
- `LITELLM_MASTER_KEY` has a single source: `gateway/.env` is canonical and
  the billing server reads it from there, so the gateway and the server can
  never disagree about the key. The duplicate copy in
  `billing/server/.env` is gone. An explicit environment variable still wins.
- Windows: LiteLLM's query-engine liveness probe used `os.kill(pid, 0)`,
  which CPython maps to `TerminateProcess` — the probe killed the very engine
  it was inspecting, so every Prisma call failed and the proxy shut down.
  One shared, platform-safe probe (`gateway/litellm/proxy/process_probe.py`)
  now serves every call site. See `gateway/PATCHES.md`.
- Windows: prisma-client-py >= 0.13 stores the query engine in a
  `__slots__`-managed attribute, so LiteLLM's write to the old
  `_Prisma__engine` raised `AttributeError` and left the proxy without a
  database. The write now targets whichever attribute the installed client
  has.
- The stack launcher is one implementation again: `scripts/lib/stack.ps1`
  holds the single service table and the launch/stop logic, and
  `scripts/start.ps1` and `scripts/restart.ps1` both use it. Every service
  runs as a Windows scheduled task, so it has a real console (Prisma's engine
  needs one) and outlives the shell that started it. A restart now waits for
  the port to be released before starting the replacement.
- `scripts/fix-ps1-encoding.py` keeps the PowerShell scripts ASCII-only and
  BOM-encoded so Windows PowerShell 5.1 parses them correctly.

**Multi-tenant PayPal (2026-11-02)** — P1 of the architecture plan
- A merchant's PayPal account is theirs, not the platform's. Every PayPal call
  now goes through a client built from the org's own row
  (`organizations.paypal_config`), with the client secret encrypted at rest and
  the access token cached in Redis per org. `external/paypal/paypalClient.ts`
  replaces the process-global client; the org row wins, and the `PAYPAL_*` env
  vars remain as the back-compat fallback for single-tenant deployments.
- Per-org configuration is split per environment (`paypal_config.test` /
  `.live`), like a PayPal REST app. The env fallback applies only when the org
  has no `paypal_config` at all — once an org manages its own PayPal the
  shared account never bills for it.
- Webhooks move to `POST /webhooks/paypal/:orgId/:webhookId`. The org comes
  from the path, so the signature is verified against THAT org's webhook id,
  and the environment is resolved from the webhook id. Event dedupe reuses
  the durable `webhook_events` table with a `paypal:` prefix rather than adding a second
  table for the same job.
- The dashboard gets a PayPal section (Settings > Integrations): connect with a
  client id and secret, verified against PayPal BEFORE they are stored, the
  webhook URL to paste into the merchant's app, and a disconnect.

**The merchant's price sheet (2026-11-02)** — P2 of the architecture plan
- What a merchant charges is the merchant's decision, so a provider price
  change cannot move it. `served_models` is the per-org price sheet, split by
  environment: `model_id` (the billable id), `upstream_model` (the LiteLLM
  deployment), `enabled`, input/output cost per 1M tokens, and a markup that is
  NULL when the plan's markup should apply. The provider price (models.dev) is
  only the SEED used when a row is created.
- The track path prices from the org's row when it has one and falls back to
  the old path when it does not, so an org that never opens the Models tab
  behaves exactly as before.
- Price pinning: `/check` resolves the unit rates and returns them as
  `pricing.pinned_rates`; the gateway passes them back on `/track_tokens`, and
  the settle uses them verbatim (`markup_source: "pinned"`). The reservation
  and the charge are the same price even if the merchant edits their sheet in
  between.
- The dashboard gets a Models tab (Catalog > Models) with inline-editable
  prices, a markup, and a margin preview against the provider price.
  Verified end to end: a call at the feature's 20/80 cost 0.36; after setting
  60/100 in the dashboard the same call cost 1.76.

**The inference proxy and the SDK (2026-11-02)** — P3 of the architecture plan
- `POST /v1/chat/completions` on the billing server: the merchant's app calls
  it with its MeterPal secret key (or a customer virtual key). The proxy
  resolves the org, the model it may serve and the end user being billed, then
  forwards to the shared gateway with that customer's virtual key — the
  gateway's bridge stays the single metering authority. The response is the
  OpenAI shape verbatim plus a `meterpal` block with what the call cost.
- The billable model id is resolved per org: the gateway names a model its own
  way (`demo-gpt`) while the merchant's price sheet names it the way they bill
  it (`custom/demo-gpt`). A single global alias map cannot serve two merchants
  selling the same upstream model under different ids, so the org's own sheet
  is the authority.
- `@meterpal/sdk` — `createMeterPal({ apiKey })` gives a merchant's server a
  chat client whose calls are metered. The secret key stays on the server; the
  client mints a per-customer virtual key on first use and caches it
  process-wide. Errors are typed, because the paywall is the product:
  `InsufficientBalanceError` carries `topUp()`, which opens the PayPal
  checkout.
- `npx @meterpal/sdk init` detects the framework (Next, Hono, Express,
  Fastify), writes the environment and a server-side handler that keeps the key
  off the browser.
- The demo app now uses the SDK instead of a hand-rolled proxy, and shows the
  merchant's own price sheet as a model picker with the charge under every
  reply.

**Gateway hardening (2026-11-02)** — P4 of the architecture plan
- The virtual key carries the tenant: `<org>:<customer>` is the key's
  identity, so the gateway resolves which merchant a call belongs to from the
  key itself. A `user` header the caller controls can no longer redirect a
  charge, and an admin key (no tenant) is refused outright
  (`missing_billing_identity` / `unresolvable_tenant`) instead of billing a
  guess.
- The gateway presents a shared `PAB_TRUST_SECRET` (single source:
  `gateway/.env`) and names the tenant it resolved; the billing server loads
  that org and looks the customer up inside it, so a request naming another
  org's customer is refused, not billed.
- The price sheet is the gateway's allow-list: each key carries the org's
  enabled upstream models, kept in sync when the merchant edits the sheet
  (`syncOrgLitellmKeys` on served-model upsert/delete).
- Two ceilings. Per customer, rpm/tpm on the key, seeded from the plan (free
  20/50k, pro 120/400k, pro_plus 300/1M, ultra 600/4M). Per org, rpm/tpm in
  the bridge, counted in the gateway's Redis so the ceiling holds across every
  gateway instance.
- `scripts/verify-tenant-isolation.ps1` drives the gateway directly and
  asserts all of it: the key beats a spoofed customer header, an admin key is
  refused, a model that is not on the price sheet is refused, and an unknown
  key is refused.

**Judge's-chair re-verification, round 2 (2026-11-11, later)** — a second pass
over the same beats, this time watching what the first pass had only reasoned
about. Eight more defects, four of them on screen:

- **A rate-limited poll deleted the buyer's pending approval.** Two UI loops
  watched the same order (the approval ticker at 2s, the durable banner at 4s)
  for ~45 requests/min against a per-customer budget of 30. Billing answers a
  refusal with `{ error: "rate_limited" }`, the demo proxy flattened it to
  HTTP 200, and the handler read "no `status` field" as "settled" and deleted
  `metadata.pending_agent_checkout`. The order stayed live at PayPal while the
  approval link vanished from the page — and it lived only in the message list,
  so a reload lost it for good. Three changes: the proxy now polls **once** for
  every reader (single-flight plus a 2.5s TTL cache, ~24 upstream calls/min no
  matter how many loops the page runs) and propagates the upstream status
  instead of flattening it; the handler clears the mirror only on a real answer
  (`captured` or `none`); and `/paypal/poll` gets its own larger limiter budget,
  because a poller polling is the route working, not abuse. Verified: 140s of
  dual-loop polling, zero 429s, mirror intact; and with the bucket deliberately
  burned, the proxy returns 429 and the approval survives.
- **The studio header understated a turn by ~9×.** It reported the *last model
  call's* charge as "last turn", but one prompt is a chain — a measured turn
  made 10 calls totalling 2.48 credits and the header said 0.28. It now sums
  the chain and says so ("this turn 2.4804 credits across 10 model calls"),
  reconciled against the wallet's own drop. The window is 20s, not 4s: measured
  gaps between steps inside one chain were up to 8s.
- **The merchant's ledger still listed holds as usage.** The customer-facing
  panel was fixed in round 1; `Customers → <customer> → Usage` and
  `Usage → Logs` were not. The customer Usage table now filters to settled
  charges (`idempotency_key` present — the same discriminator the SDK panel
  uses), and the raw log keeps every row but labels it: a **Kind** column with
  `charge` / `reserve` / `release`, so a `-0.302` with empty properties reads as
  the hold it is instead of a charge that makes no sense.
- **The AG Grid beat ended on an empty grid.** A widget is a shell (`type`) plus
  a `dataMapping`; the agent reliably built the first and sometimes omitted the
  second, which is not an error anywhere in the stack — the widget simply
  renders "No Rows To Show" under a perfectly good title. Four fixes:
  - The widget agent now gets the table's exact field ids and the mapping shape
    per widget type (`DATA_BINDING_GUIDE`), and `demo/mock_agent.py` emits the
    shape for the type it is configuring instead of always a chart's.
  - **The mapping has to bind, not merely exist.** Studio stores whatever keys
    it is given: a chart-shaped mapping (`categoryKey`/`valueKey`) patched onto
    a *grid* leaves the grid's own `cols` as `[]`. The widget then carries a
    `dataMapping` object that passes an `Object.keys().length > 0` test while
    pointing at nothing — which is why the first pass at this still ended on an
    empty tile. `repairUnboundWidgets` now tests the keys the widget's *type*
    reads (`bindsData`), so a wrong-shape mapping is repaired like a missing
    one.
  - **A grouped grid lost its duplicate footer row.** Grouping aggregates the
    dimension with `first`, and the grand-total row aggregates it the same way,
    so the footer repeated the customer name from the row above it and read as
    a second row of data. Grouped grids now set
    `format.style.grandTotalRow.enabled = false`; ungrouped grids keep theirs,
    where the label lands in an empty first column and reads as a total.
  - `demo/mock_agent.py` is loaded by a long-running process, so editing it
    changes nothing until `scripts/restart.ps1 mock-llm`.
  - **Verified.** "A table of usage by customer, one row per customer" renders
    `meterpal-setup-test | 0.13` as a single row with no footer, and "a column
    chart of credits by feature" renders a bar at 0.13 — both with no
    empty-state overlay. A report saved with a broken widget (`cols: []`, title
    "Credits by customer") is repaired on the next load: the pass runs on the
    state update Studio raises at hydration, so a bad save heals itself rather
    than staying empty until someone asks the agent again.
- **Both doc corrections were missing from the tree.** `docs/HACKATHON-SUBMISSION-CHECKLIST.md`
  still said "no human touches billing" in the money-shot beat a judge reads
  during the shot (now: "no human touches the billing code"), and
  `docs/PRESENTATION-PLAN.md` still said the buyer's agent "tops up on its own"
  — the exact self-charging overclaim, in the document the checklist defers to
  (now: "opens a top-up and hands it to the buyer, who is the only one who can
  approve the payment").
- **Ledger rows missed their own total by 0.0001.** Charges of `0.00518` and
  `0.02556` were printed at 4dp, so four visible rows added to `0.0412` against
  a true `0.0411`. Five decimals below 1 credit, trailing zeros trimmed, so the
  column reconciles and `0.5` still reads `0.5`.
- **The price sheet showed no margin at rest.** `served_models` carried $20/$80
  as the *cost* with a 0% markup — a reseller working for free — so the 90%
  story only appeared after someone edited the sheet by hand. The sheet now
  states the real cost ($2/$8) and the real markup (900%), which bills the same
  $20/$80 and shows the margin on first look. Two $0/$0 rows with no deployment
  were removed; they could never be served and priced metering at zero.
- **The capture proxy did not check who owned the order.** Credits always
  landed with the order's owner, so this was never theft — but any
  authenticated customer could force a capture on another customer's approved
  order. `POST /paypal/capture/:order_id?customer_id=` now 403s on a mismatch;
  callers that assert no identity (the SDK's own `onApprove`) are unaffected.

Also: the persona switcher remembers its selection across reloads (a reload
used to snap back to the funded customer mid-demo), and the projected-runway
line no longer dresses a single day's spend up as a trend — it says
"extrapolated from today's spend only, no trailing week yet" when that is what
it is.

**Round-2 pass B (2026-11-11, last)** — the eight fixes above verified in the
browser, plus one blocker the local stack could never have shown:

- **A fresh clone could not build.** Fourteen files that committed code already
  imported were untracked — the studio's layout pass, the console wallet, the
  wallet projection behind `readWallet`, the chat-delivery handlers and their
  settings section, the mock PayPal server `stack.ps1` starts, `JUDGE-TESTING.md`
  that the README links to. The local stack was green because the files were on
  disk; the artifact was not. All are committed, and the verification is now
  "clone to a temp directory and resolve every import in it" rather than "the
  stack runs here".
- **`.gitignore` was hiding twelve source directories.** A bare `logs/` rule,
  meant for the stack's own log output, matches a directory of that name at any
  depth — including `.../licenses/actions/logs`, `.../billing/v2/utils/logs` and
  `.../customers/actions/createWithDefaults/logs`, which hold real TypeScript.
  The rule is root-relative now (`/logs/`, `/demo/logs/`), and the gateway's
  Next.js export — the one genuine build output that was relying on it — is
  ignored explicitly. A clone now resolves 8,140 relative imports with none
  missing.
- **The agent's second widget landed on its first.** `mock_agent.py` placed
  every widget at a hardcoded `yTrack: 45`, which is where the seeded table
  ends, so a chart asked for after a table arrived on top of it and Studio's
  validator logged a layout failure in the console mid-demo — the page ended up
  right only because the repair pass moved it afterwards. The page agent now
  reads `view_page` before it places and puts the widget below everything else.
- **A collided widget was moved to the bottom of the page.** Correct, but it
  left a band of empty canvas between the tile and what it had been moved away
  from, which reads as a gap rather than a placement. It now goes into the first
  free row under the tile it collided with.
- **Two tiles were both called "Usage detail".** The agent's grid took the
  seeded grid's title. Tables are now named for what they group by ("Usage by
  customer"), so the page never shows the same heading twice.
- **A second request in the same conversation built nothing.** The orchestrator
  answered "have I already done this?" against the whole transcript, so after
  one widget the next prompt found the page already read, a plan already written
  and the delegation already made, and replied with the *previous* turn's
  summary. Lookups are now scoped to the current request, anchored on the last
  message the merchant actually typed (a delegation instruction is also a
  user-role message, and it carries the plan).
- **An unreachable billing server answered 500.** The poll proxy reported "not
  reachable" as status 0, which is the right internal signal and not a valid
  HTTP status; Hono throws on `c.json(body, 0)`. It answers 503 now, which is
  what the caller's `res.ok` branch already assumed.
- A stray pending $10 sandbox order (`6R8774075D733940A`, from a top-up modal
  click with no agent banner) was marked abandoned so the only live order in the
  database is the one on screen.

## 0.1.0-baseline — 2026-09-30 (pre-hackathon)

The starting point, predating the hackathon submission window. This baseline
was committed to the public repository on day one of new work so that all
submission-period changes are transparent in git history.

**Wallet & metering core** (fork of Autumn, Apache-2.0 — see NOTICE):
- LiteLLM bridge tables (`bridge_audit_log`, `bridge_rate_limits`,
  `wallet_ledger`, `webhook_events`) and customer bridge columns
  (`litellm_virtual_key`, `paypal_subscription_id`, `paypal_plan_id`,
  `paypal_payment_status`) — migration `0085_shallow_iron_man`.
- Virtual key provisioning (`litellmKeys.ts`, `litellmWebhookTriggers.ts`).
- Balance plumbing fixes: plpgsql function installer at boot, inline event
  batch fallback in development, Redis v2 cache pool config.

**PayPal webhook adapter** (pre-hackathon, ~630 lines):
- `external/paypal/client.ts` — OAuth + idempotent REST client (sandbox/live).
- `external/paypal/webhookSecurity.ts` — local crypto webhook signature
  verification (CRC32 + cert pinning + SHA256withRSA, timestamp freshness).
- `external/paypal/webhookRouter.ts` + `runPaypalWebhookHandlers.ts` —
  `BILLING.SUBSCRIPTION.*` / `PAYMENT.SALE.*` / `PAYMENT.CAPTURE.*` lifecycle
  wired to entitlement provisioning and wallet ledger grants (idempotent).
- `external/paypal/orders.ts` — Orders v2 create/capture/refund wrappers.

**AI gateway** (fork of LiteLLM, MIT — see NOTICE):
- `litellm/integrations/autumn_billing.py` — pre-call admission control
  (`/check` → HTTP 402 before the provider is touched), post-call usage
  tracking (`/track_tokens`, `/balances.finalize` commit/release), fail-open /
  fail-closed modes, model-id mapping. 14 unit tests.
- `config.yaml`, `.env.example` wiring.

**Customer UI components** (`apps/billing-ui`, now `sdk/typescript`):
- CreditsBadge, LowBalanceBanner, PlanCard, TopUpModal, UsageHistoryPanel,
  CostTooltip + smoke tests (known build bugs at baseline; fixed post-baseline).

**Demo** (`demo/`): mock LLM provider, bootstrap seeding, 6-phase billing-loop
walkthrough, all without real payment or provider keys.

**Docs**: `docs/plan.md`, `docs/bridge.md`, `docs/customer-ui.md`,
`docs/DEPLOY.md` (production guide; rewritten as a PayPal-native
guide during the submission period).
