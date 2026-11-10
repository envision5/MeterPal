# Presentation Plan — PayPal AI Hackathon (video + Devpost)

Companion to `docs/HACKATHON-SUBMISSION-CHECKLIST.md`. This is the record-and-submit
playbook: script, staging, recording setup, and the written Devpost copy — all drafted
so you only have to execute.

**The strategy in one paragraph.** Your implementation is already top-decile; your
Design surface is not. So the video must (1) put the *consumer-grade* surface — the
demo chat app with the credits badge and top-up modal, and the AG Studio usage
dashboard — on screen instead of the terminal, (2) make "an agent that ran out of
money and bought its own credits on PayPal" the memorable sentence of the whole
event, and (3) spend 25 seconds proving the depth is real (forged webhook → 401,
live ledger) so the judges' "Technological Implementation" score has evidence, not
vibes. Every judging criterion gets a dedicated beat. Nothing here can *guarantee*
a win — it removes the reasons you'd lose one.

**On AG Grid (added Nov 10).** The Usage Studio (`/sandbox/studio` in the
dashboard) is a real AG Grid **AG Studio** surface — `ag-studio-react@3.1.0` on
`ag-grid-react/enterprise/stack@36.3.0` — and its assistant is AG Studio's own
multi-agent framework, wired to MeterPal's metered gateway. That makes the
**Best Use of AG Grid** sponsor prize an honest claim, not a logo, and it gives the
merchant side of the video the design surface the strategy paragraph above says is
the weak point. Beat 4 exists to show it. AG Studio is commercial: without a
license key the canvas carries a watermark and the AI features warn in the
console. The free 45-day trial unlocks them — either get the key before recording
or shoot the watermark and say so honestly.

---

## 1. The video script (target 2:55; hard limit 3:00)

Narration is written to be read verbatim. [Screen] lines are what the viewer sees.
Timecodes assume a normal speaking pace — rehearse with a stopwatch and cut, don't
speed up the audio. **The sheet was re-timed on Nov 10 to fit the AG Studio beat
inside the 3:00 hard limit** — if you are shooting from an older copy of this file,
it still runs 3:30 and will be rejected.

### Beat 1 — The missing layer (0:00–0:18)
**[Screen: black title card → "PayPal can move the money. Who stops the spend?"]**

> "Every AI product has the same missing piece. When your user runs out of credits,
> the call just fails — and nothing in PayPal's catalog stops the call that spends
> the last credit. Orders, subscriptions, invoices — PayPal moves the money
> beautifully. Its Usage Based Billing API meters usage and invoices after the
> fact, in arrears. But arrears means the overspend already happened. So we built
> the layer that's missing: the meter that sits in the request path and refuses
> with HTTP 402 before any spend."

**Why this opener:** it makes a verifiable claim about the sponsor's own catalog
(their Usage Based Billing API is arrears-only — no admission control, no hard
cap; see `docs/research/paypal-agentic-commerce-and-metered-billing-brief.md` — say it
with confidence), positions you as infrastructure, and tells judges
in 20 seconds what they're looking at. Most entries open with "imagine a world
where…" — don't.

### Beat 2 — The paywall, in a real app (0:18–0:50)
**[Screen: demo-app chat UI. A user chats with the AI; the credits badge ticks down
after each reply. The next reply returns 402 → the app shows the
`InsufficientBalanceError` card with a **Top up** button → click → PayPal sandbox
popup → approve → back in the app → credits badge jumps → the same message
succeeds.]**

> "This is a working chat app. Every reply is metered per token — input, output,
> cache — priced from the merchant's own sheet, and debited from a prepaid wallet
> atomically, before the model is called. Watch the badge. When the wallet runs
> dry, the next call is refused with 402 — before any provider spend. The SDK
> turns that into a typed error with a top-up button. The buyer approves on
> PayPal, the webhook lands, the wallet fills — instantly, not in a nightly
> batch — and the user keeps going."

**Staging note:** this beat runs through the demo-app's **in-page capture** path
(`POST /paypal/capture` → credit), which works fully on localhost — no public
webhook tunnel needed, nothing to time out on camera. The webhook beat is Beat 5.

### Beat 3 — The agent that buys its own credits (0:50–1:24)
**[Screen: terminal, large font. `python agent/buyer_demo.py`. The agent's call
hits 402. It decides, creates a PayPal order, prints the approval link. Switch to
browser: sandbox approval, click Pay. Back to terminal: "waiting for webhook…" →
balance credited → the agent retries and succeeds. Show the wallet_ledger rows
landing.]**

> "Now the part that matters for agentic commerce. This is an autonomous agent.
> Its task failed with 402 — insufficient balance. Nobody is watching. The agent
> decides on its own to buy a credit pack, creates the PayPal order through the
> API, the buyer approves with real sandbox consent, the capture webhook credits
> the wallet, and the agent retries its task and succeeds. An AI agent paid for
> its own compute on PayPal. That loop — refuse, purchase, resume — is the
> commercial primitive every agent economy needs."

**Staging note:** pre-drain the wallet below headroom BEFORE recording so the 402
lands on the first call (run_demo phase 4, stop before the top-up). The buyer
approval click is the only manual step — practice it once; keep the sandbox buyer
already logged in on that browser profile.

### Beat 4 — The Usage Studio: a dashboard whose builder is metered (1:24–1:54)
**[Screen: dashboard → "Usage Studio" in the sidebar (`/sandbox/studio`). The AG
Studio canvas: a merchant's usage dashboard — KPI tiles, a spend-over-time line
chart, a feature donut, a usage table. The AI Assistant panel is open on the left.
Click a prompt starter — "Breakdown by feature". Watch the agent's delegation steps
tick by: *Read the page → Delegated to Page agent → Delegated to Widget agent*.
A new "Credits by feature" column chart appears on the canvas, drawing real bars.
The header reads: "last turn cost 0.00554 credits, balance 8.8456."]**

> "This is the merchant's usage dashboard, built on AG Grid's AI Studio — and it is
> not a screenshot. The assistant is AG Studio's own agent framework, and every turn
> it takes — reading the page, placing the widget, mapping the data — is billed
> through MeterPal. So the agent that builds your dashboard is metered to the
> customer's wallet, and the cost of the last turn is right there on screen. No
> agent gets a free ride, not even the one writing your charts."

**Why this beat:** it is the only beat that shows a *finished product* rather than a
mechanism, which is what the "Design surface is the weak point" problem needs. It
also carries three judging criteria at once — **Best Use of AG Grid** (the studio
is AG Grid's own, driven by AG Grid's agent framework), **PayPal + AI** (the agent
runs on metered inference), and **Agentic Commerce** (the end customer's wallet
pays for it).

**Staging note:** select `demo-customer` in the header dropdown before recording
(its wallet is the one that funds the agent, and the numbers are non-trivial).
Collapse the Filters / Compose / Data side panels so the canvas fills the frame —
their chevrons are the double-arrow at the right of each panel header. The report
persists per customer in `localStorage`, so a reload keeps the agent's widget;
press **Reset** (top right) to get back to the seeded dashboard between takes.

### Beat 5 — Merchant side + proof of depth (1:54–2:20)
**[Screen: dashboard. PayPal connect panel (masked client id, verified check). Then
the served-models price sheet: edit demo-gpt output price → save. Then terminal:
the next call bills at the new price — show the ledger row. Then: `curl` a FORGED
PayPal webhook → server answers `401 invalid signature`. Then the ledger query
showing per-call token pools, base cost, markup.]**

> "Merchants bring their own PayPal account — credentials are verified before
> they're stored, encrypted at rest, and scoped per organization. What a merchant
> charges is the merchant's decision: change the price in the sheet, and the very
> next call bills at the new price — the reservation and the settle are pinned to
> the same quote. And because this is money, we audited it like money: a forged
> webhook is refused with an invalid-signature 401. Every grant is idempotent.
> Every dollar reconciles to a ledger row. The full security assessment is in the
> repo."

**Why the forged webhook:** it is the single most convincing 3-second shot you own
— an attacker attempt, refused, on camera. It converts "trust me" into
"demonstrated."

### Beat 6 — The loop where both sides are AI (2:20–2:45)
**[Screen: split — demo-app "Talk to sales" tab (customer) + dashboard "Agent approvals" (merchant).
Customer types their need → the agent quotes real ledger math → drafts the package. Cut to the
merchant: the draft sits in Approvals with the math beside it → one click → "Approved — plan minted".
Back to the customer: the offer card appears → Accept → the PayPal sandbox checkout opens. Then the
paywall moment with the buyer agent: 402 → "your agent is on it" → PayPal approves → back in chat.]**

> "Now the part only MeterPal can do. The customer's side is an agent too: it hears what they need,
> reads their real usage from the ledger — burn rate, runway, down to the call — and drafts a
> package sized to it. Nothing takes effect without a human: the merchant approves with one click,
> the plan is minted instantly, and PayPal itself approves the payment. The buyer's AI runs inside a
> hard mandate — when the wallet runs dry it tops up on its own, and the same 402 wall that stops a
> human stops it the moment the budget says so. Both sides of the transaction are agents acting on
> the same ledger — and neither can overspend."

**Why this beat:** it is the agentic-commerce entry PayPal built this hackathon for — usage-grounded
negotiation, a merchant approval gate, a buyer mandate, and PayPal rails end to end. The agent's own
tokens are metered by MeterPal (a dedicated agent wallet): say it — "our sales rep pays for its own
inference."

### Beat 7 — Close (2:45–3:00)
**[Screen: the architecture diagram from the README → repo URL → title card
"MeterPal — the billing rail for the agent economy."]**

> "MeterPal is the billing rail for the agent economy: one SDK swap, every call
> admitted, metered and charged through the merchant's own PayPal. No overspend.
> Instant access after payment. No double billing. No cross-tenant charges.
> Install the SDK, and your AI app bills itself — clone the repo to run the whole
> stack yourself. The repo and full docs are linked below."

**Cut checklist:** no dead cursor time >2s; every terminal shot has zoomed font;
no email/usernames/real paths with your name visible; no OpenAI/Anthropic logos;
no music you don't own (silent with good VO beats bad music).

---

## 2. Pre-staging choreography (do this before hitting record)

- [ ] `docker compose up -d`, billing server, mock LLM, gateway up and healthy (curl all three)
- [ ] `python demo/bootstrap.py` — fresh state, price sheet at $20/M / $80/M
- [ ] For Beat 4: the dashboard at `/sandbox/studio` loads with real usage, `demo-customer`
      selected in the header dropdown, Filters/Compose/Data panels collapsed, and a
      known-good agent turn rehearsed once (the studio's report persists per customer
      in `localStorage` — **Reset** in the header puts it back to the seeded dashboard)
- [ ] Demo-customer wallet set to a value that drains in ~4 chat replies for Beat 2
      (set via `POST /v1/balances/update {remaining: X}`)
- [ ] For Beat 3: wallet drained below headroom; sandbox **buyer** account logged in
      on the recording browser profile; `topup_10` pack visible in checkout
- [ ] Browser zoom 125–150%, terminal font 18–20pt, dark theme everywhere, one
      clean desktop, notifications off, bookmarks bar hidden
- [ ] All five terminals/tabs pre-positioned in the order the script visits them
- [ ] Two full dry runs (untimed), then one timed take. Record 3 takes; pick the best;
      splice only if the joins are invisible
- [ ] Record at 1920×1080 or higher, 30fps+, mic close and quiet room; VO over
      screen capture (no face cam needed — judges score the product, not you)

**Webhook note:** the demo-app beat credits via in-page capture (localhost-safe).
If you want the *webhook* visible on camera (Beat 3's "waiting for webhook…"),
register the PayPal webhook to a cloudflared/ngrok tunnel BEFORE recording and
confirm one real `PAYMENT.CAPTURE.COMPLETED` arrives end-to-end in rehearsal. If
the tunnel is flaky that day, record the capture-path version — never gamble the
take on a tunnel.

---

## 3. Devpost written description (paste, then personalize)

> **MeterPal — the billing rail for the agent economy**
>
> PayPal can move money for AI products — but nothing in its catalog enforces a
> spend cap in real time. PayPal's Usage Based Billing API meters usage and
> invoices in arrears: the overspend happens first, the invoice follows, and a
> prepaid balance is a display, not a gate. MeterPal is the enforcement layer —
> the meter that sits in the request path and refuses the call before the spend
> exists.
>
> One SDK swap: your app's AI calls are admitted against a prepaid wallet
> (refused with HTTP 402 *before* any model spend), metered per token from the
> merchant's own price sheet, and debited atomically. When the wallet runs dry,
> the SDK raises a typed `InsufficientBalanceError` with a top-up helper — and an
> autonomous agent can use it to buy its own credits: it creates a PayPal order,
> the buyer approves, and the signature-verified `PAYMENT.CAPTURE.COMPLETED`
> webhook fills the wallet in real time. Credit packs ride Orders v2, plans ride
> Subscriptions, overage rides Invoicing, disputes and refunds reconcile back to
> the wallet. Every merchant connects their own PayPal account — credentials are
> verified live, encrypted per org, and every webhook signature is verified
> against that org's own webhook id.
>
> Under the hood: a Redis/Lua atomic reservation core (N concurrent requests can
> never spend past the balance), an idempotent ledger (no double billing on
> retries), and a shared LiteLLM gateway whose metering hook carries the tenant
> in the key itself — a spoofed customer header or an admin key cannot redirect a
> charge. We ran an adversarial security audit of our own money path
> (docs/SECURITY-ASSESSMENT.md) and fixed everything it found.
>
> The merchant's usage dashboard is built on **AG Grid's AI Studio** — and its
> assistant is AG Studio's own agent framework, wired to MeterPal's metered
> gateway. Ask it for a chart and it reads the page, places the widget and maps
> the data — and every one of those turns is billed to the customer's wallet, with
> the cost of the last turn shown on screen. The agent that builds the dashboard
> pays for itself, like everything else in this platform.
>
> Run it yourself: this repo is the full product source — in production merchants
> install the SDK and never see the gateway, but here you can clone,
> `docker compose up`, bootstrap, and run the guided demo: it drains a wallet,
> hits the 402 paywall, and tops up — start to finish in about
> five minutes. **AI tools used:** AG Grid AG Studio (the merchant's usage
> dashboard and its multi-agent assistant — metered), the demo models via the
> bundled mock provider, the AI onboarding assistant, the MCP agent surface —
> every one of them is metered and billed by the platform it runs on.

**Title options (pick one):**
1. "MeterPal — the billing rail for the agent economy" (recommended)
2. "MeterPal — usage-based billing for AI, on your own PayPal"
3. "Your AI agent just paid for itself — MeterPal"

**Screenshots to attach (6):** credits badge mid-drain in the chat app · the 402
insufficient-balance card with Top up · the agent's 402→purchase→resume terminal
flow · **the Usage Studio canvas with the agent-built chart and the metering
banner** · the served-models price sheet · the forged-webhook 401 next to a live
ledger query.

---

## 4. Category targeting (decide once, don't waffle)

- **Best Use of PayPal + AI** and **Best Use of Agentic Commerce** — enter both
  emphatically; your Beats 3–4 are literal demonstrations of both.
- **Best Use of AG Grid** ($5,000) — **enter this one too.** The rules allow one
  Grand Prize *and* one Sponsor Prize per project, so it is additive, not a
  trade. It is also an honest claim: the merchant's usage dashboard is a real AG
  Grid **AG Studio** surface (`ag-studio-react@3.1.0` on
  `ag-grid-react/enterprise/stack@36.3.0`), and its assistant is AG Studio's own
  agent framework driven through MeterPal's metered gateway. The evidence for the
  judges is in the repo, not just the video: `billing/vite/src/views/studio/`
  (the studio page, data source and adapter), `billing/server/src/internal/studio/`
  (the metered turn), and `demo/mock_agent.py` (the offline agent that reproduces
  the delegation chain with no provider keys).
- **Best Demo Delivery** — winnable with this script; the 402 moment, the
  agent-built chart, and the webhook credit are the beats judges remember.
- Still **do not claim sponsor tools you don't genuinely use** (APIMatic etc.).
  AG Grid is the one that is genuinely used — don't extend that to any other.

## 5. Rehearsal protocol

1. Read the script aloud twice, alone, with a timer — rewrite any sentence you stumble on.
2. Full dress rehearsal with the real stack; watch the take with fresh eyes the next morning.
3. The 30-second test: show the video to someone who knows nothing; if they can't
   repeat back "PayPal has no usage billing, MeterPal meters AI calls, and an agent
   bought its own credits," re-cut.
4. Submit 48 hours before the deadline — the form itself takes an hour and the
   upload always needs a retry.
