# Hackathon Submission Checklist — PayPal AI Hackathon (deadline Nov 12, 2026)

Companion to `docs/SECURITY-ASSESSMENT.md`. This is the operating plan to maximize
the win probability, built from a **judge's-chair audit** (every claim below was
executed against the live stack on Nov 5).

---

## 0. What this audit found and already fixed (verified)

Running the project the way a judge would surfaced five real breakages in the
demo path — all fixed and re-verified end-to-end on Nov 5:

| # | Was broken | Impact | Fix (verified) |
|---|---|---|---|
| 1 | `bootstrap.py` used a stale DB role (`meterpal` vs compose's `autumn`) | **Bootstrap crashed on every fresh clone** — judges could not even seed | Constants corrected; bootstrap now runs clean |
| 2 | `run_demo.py` called the gateway with the LiteLLM **master key** | Every call 403'd (`unresolvable_tenant`) — the tenant-isolation guarantee working, the demo not updated | Demo now provisions the customer's **virtual key** (the merchant-SDK path) and calls with it |
| 3 | Bridge sent `action: "commit"`; the API only accepts `"confirm"` | **Every successful request kept its reservation hold** — wallets locked by their own holds until TTL (pre-existing money bug) | Mapped to `confirm`; holds release correctly (0.36/call exactly) |
| 4 | Legacy checkout sent `product_id`; the v2 pipeline reads `plan_id` | **Every top-up 404'd** ("Product undefined") — SDK `topUp()`, the buyer agent's purchase, the entire 402→buy→resume story were dead | Mapped in `handleLegacyApiCheckout`; verified a real PayPal sandbox approval URL returns |
| 5 | Python SDK parsed `balances` as a list; the API returns a dict | Buyer agent crashed on every balance read | Fixed; buyer demo runs |
| 6 | Free-plan gateway limits (50k TPM) tripped mid-demo; bootstrap rates drifted from dashboard edits | 429s stole the 402 moment; printed costs lied | Limits → 500k TPM; bootstrap now resets feature rates **and** the served-models sheet every run; wallet sized so the 402 lands mid-drain (call 9) |

Also fixed: zero-token failure events (each 402 hit) no longer 400/dead-letter; demo
text now matches actual cache-pricing behavior.

**The complete judge path now runs green**: bootstrap (12 ✓) → run_demo (calls 1–8
metered at exactly $0.36, **402 on call 9**, top-up re-admits, ledger complete) →
merchant agent tools → buyer agent through the virtual key → checkout returns a live
PayPal sandbox approval URL.

---

## 1. THE JUDGE RUNBOOK — make this the README quickstart, verbatim

The current README "Try it in 60 seconds" **does not work on a fresh clone** (no
`.env` copy step, no schema migration step, wrong install dir for a workspace).
Replace it with this verified sequence:

```bash
# 0. prerequisites: Docker, Bun, Python 3.11+, and:
pip install httpx fastapi uvicorn

git clone <repo> && cd meterpal

# 1. infrastructure (2× Postgres + 2× Redis)
docker compose up -d

# 2. billing server config + schema
cp billing/server/.env.example billing/server/.env
cd billing
export AUTUMN_DB_DIRECT=1
export DATABASE_URL="postgresql://autumn:autumn_dev_only@localhost:5433/autumn"
bun scripts/db/index.ts migrate --bootstrap     # no Infisical needed
unset AUTUMN_DB_DIRECT DATABASE_URL
cd ../

# 3. install + run the billing server (:8080)   [bun installs the workspace from billing/]
cd billing && bun install && cd server && bun src/index.ts &
cd ../..

# 4. mock LLM (:9999) + gateway (:4000)
python demo/mock_llm.py &
cd gateway && set -a && source .env && set +a && pip install -e . && litellm --config config.yaml --port 4000 &
cd ../..

# 5. seed + walkthrough
python demo/bootstrap.py && python demo/run_demo.py
```

**CHECKLIST (README/docs):**
- [x] Replace the README quickstart with the runbook above (exact commands, expected output snippets)
- [x] State the one-command claim honestly: "~5 minutes from clone to a metered AI call"
- [x] Add a "Judges: what to look at" box — the 4 files that show the work (`meterpal_billing.py`, `webhookSecurity.ts`, `pinnedRatesStore.ts`, `run_demo.py`)
- [ ] Verify on a REAL fresh clone (delete node_modules + docker volumes, run the runbook) — **this is the single highest-value hour left**
- [x] Note Windows/mac/Linux differences you actually tested; mark the rest "should work" (README: verified on Windows/Git Bash; other shells should work)
- [x] `bun install` runs from `billing/` (workspace root) — fix any doc that says `cd billing/server && bun install` first

---

## 2. GitHub upload checklist

- [x] Commit today's demo-path fixes (`demo/bootstrap.py`, `demo/run_demo.py`, `agent/buyer_demo.py`, `sdk/python/src/meterpal/client.py`, `gateway/litellm/integrations/meterpal_billing.py`, `handleLegacyApiCheckout.ts`, `litellmKeys.ts`)
- [x] **Secrets scan of the entire git history before pushing public** (the repo has 154 MiB / ~22k files):
      `git log -p | grep -iE "PAYPAL_CLIENT_SECRET|sk_live|BEGIN PRIVATE KEY|resend|axiom|logtail"` — the demo seed key `am_sk_test_JvWn…` in `bootstrap.py` is intentional and documented ("LOCAL ONLY"); everything else must come back clean — **ran 2026-11-08: 414 hits, all benign** (upstream import paths `logtail/logtailUtils`, `Resend`/`Axiom` provider references in code, LiteLLM test PEM fixtures in `gateway/tests/**`; the `sk_live_1050/0001/1057` Stripe test fixtures were removed from the tree by the Stripe-removal commit)
- [x] `.env` files confirmed untracked — verified: `git log --all --diff-filter=A -- "**/.env"` returns only the four `.env.example` files (intended); no real `.env` was ever committed
- [ ] Push to a **public** GitHub repo; add the repo **About** description + **license badge** (Apache-2.0) — Devpost requires the license visible in the About section
- [ ] Keep `NOTICE` (Autumn/LiteLLM attribution) and the README "What was built during this hackathon" table — the baseline commit `9cb5a2d0` (2026-09-30) is your provenance evidence; link it
- [ ] Tag the submission: `git tag submission-v1 && git push --tags`
- [x] Delete or keep the two `billing/server/debug-*.ts` probes (harmless; they're honest dev artifacts) — already deleted

---

## 3. Video checklist (≤ 3 min, public YouTube, no third-party logos/music)

**Beat sheet (180s, hard limit 180s — the sheet in `docs/PRESENTATION-PLAN.md` was
re-timed on Nov 10 to fit the AG Studio beat inside the limit):**
1. **0:00–0:18 Problem** — "Every AI app needs per-user metered billing — with a hard cap. PayPal's Usage Based Billing API meters and invoices in arrears: the overspend happens first. Nothing in the catalog refuses the call that spends the last credit. MeterPal is that enforcement layer: HTTP 402 before any model spend."
2. **0:18–0:50 The paywall works** — run_demo live: calls metered per token, wallet drains, **HTTP 402 before the provider is touched** (show the ledger row + the refusal).
3. **0:50–1:24 The agentic loop (the money shot)** — buyer agent hits 402 → decides to buy → creates a PayPal order → sandbox approval → `PAYMENT.CAPTURE.COMPLETED` webhook credits the wallet → the agent's task resumes. No human touched billing.
4. **1:24–1:54 The Usage Studio (AG Grid)** — the merchant's AG Studio dashboard: ask the agent for a chart, watch it read the page → delegate to the page agent → delegate to the widget agent → a new chart appears on the canvas, and the banner shows what the last turn cost and the wallet balance.
5. **1:54–2:20 Merchant side + depth** — dashboard: connect PayPal (credentials verified live), edit the served-model price sheet, watch the next call bill at the new price; then `curl` a FORGED webhook → 401; then the live ledger query.
6. **2:20–2:45 Both sides are AI** — demo-app "Talk to sales" (customer) + dashboard "Agent approvals" (merchant): the customer's agent quotes real ledger math, the merchant approves, PayPal approves, and the buyer's agent tops itself up when the wallet runs dry.
7. **2:45–3:00 Close** — "the billing rail for the agent economy" + repo URL.

**Checklist:**
- [ ] Rehearse the exact command order from §1 — the video must show the real thing
- [ ] Show the **402 moment** and the **webhook credit moment** on screen (they are the two beats judges remember)
- [ ] Show the **agent-built chart** in Beat 4 — the AG Grid sponsor prize is judged on how you use the tool, and the video is where they see it
- [ ] No OpenAI/Anthropic logos or music you don't own; sandbox branding is fine
- [ ] Upload public/unlisted-public, put the link in the Devpost form, and test the link in an incognito browser
- [ ] Record at the resolution you'll demo on; keep terminal font large

---

## 4. Devpost submission fields

- [ ] **Tools list** (required): name the AI models/services and how they're used — **AG Grid AG Studio** (`ag-studio-react@3.1.0` / `ag-grid-react/enterprise/stack@36.3.0`): the merchant's usage dashboard, whose assistant is AG Studio's own multi-agent framework and is driven through MeterPal's metered gateway, so every turn that builds a widget is billed to the customer's wallet; mock LLM for the metered model, the AI onboarding/pricing agents in the dashboard, the MCP agent surface; PayPal APIs: **Orders v2, Subscriptions, Invoicing, Webhooks, OAuth (per-org client credentials)**; agent model: **Agnes 2.5 Flash** via the metered gateway (the sales-rep agent and buyer agent run on it — the agent's own tokens bill to a dedicated agent wallet) — and if asked about metering, name **Usage Based Billing v1** and say why MeterPal doesn't use it for enforcement (arrears-only, no admission control; see `docs/research/paypal-agentic-commerce-and-metered-billing-brief.md`)
- [ ] **Text description**: lead with the enforcement framing ("PayPal's Usage Based Billing API bills in arrears; MeterPal is the real-time enforcement layer — HTTP 402 before any model spend"), then the guarantees list from the README, then the AG Grid paragraph (the studio dashboard whose builder is metered) — copy it from `docs/PRESENTATION-PLAN.md` §3 so the video and the form say the same thing
- [ ] **Hosted demo vs run instructions**: run instructions are the deliverable (§1); if you can also get the stack onto Render before the deadline, do it (Render is a sponsor prize; the mock LLM means no provider keys needed) — but do not let a half-working deploy block the runbook. State both explicitly: the **product** is hosted (merchants sign up and install the SDK; they never run the gateway), and the **runbook** is how judges evaluate the full stack locally
- [ ] **Screenshots**: dashboard price sheet, ledger, agent loop, webhook 401 on forgery, **the AG Studio canvas with the agent-built chart and the metering banner**
- [ ] Read the Official Rules prize section: a project can win up to **one Grand Prize and one Sponsor Prize**, so entering AG Grid alongside the grand-prize categories is allowed (verified against the rules) — confirm nothing else changed before submitting
- [ ] Submit **before Nov 12 12:00pm PST** — do not ride the deadline; the form itself takes an hour

---

## 5. Rehearsal & contingency

- [ ] Full cold run of §1 on a clean VM (or at minimum a fresh clone on this machine after `docker compose down -v` and volume delete)
- [ ] If a judge can't run it, the fallback is the video — so the video must show everything the runbook would
- [ ] Decide the enterable categories: **Best Use of PayPal + AI** and **Best Use of Agentic Commerce** are the strongest fits; **Best Use of AG Grid** ($5,000) is the sponsor prize to enter — the rules allow one Grand Prize *and* one Sponsor Prize per project, so it is additive, not a trade, and the claim is genuine (a real AG Grid AG Studio surface with AG Studio's own agent framework behind it — see §7); **Best Demo Delivery** is winnable with the beat sheet above
- [ ] Honest odds, stated plainly: the implementation depth is podium-grade; the prize will be decided by runnability + video quality against an unknown field. Everything above is designed so neither is the reason you lose.
- [ ] After the hackathon: rotate every credential in `gateway/.env` / `billing/server/.env`, and clear the synthetic pentest ledger rows with `python demo/bootstrap.py`

---

## 6. Known limitations — disclose, don't hide

- Sandbox-only (PayPal sandbox); no live-mode run
- Demo logins are seeded and not production-hardened (documented; the security assessment explains exactly what's hardened and what isn't)
- Fork lineage: Autumn core (Apache-2.0) + LiteLLM (MIT) with the built-during-hackathon work enumerated in README + git history
- The dashboard's served-models UI is functional, not polished — the demo path avoids its rough edges
- AG Studio is commercial: without a license key the canvas is watermarked and the AI features warn in the console. The free 45-day trial unlocks Pro + AI — get the key before recording, or say plainly in the video that the watermark is the unlicensed state

---

## 7. The Usage Studio — the AG Grid claim, and what backs it (added Nov 10)

The merchant's usage dashboard was rebuilt as an embedded AG Grid **AG Studio**
surface. This is the evidence behind the **Best Use of AG Grid** entry, and it is
also the "design surface" fix the presentation plan keeps calling for.

**What it is.** `/sandbox/studio` in the dashboard. The page renders AG Studio's
canvas (KPI tiles, line chart, donut, table), and its AI Assistant is AG Studio's
own multi-agent framework — orchestrator, page agent, widget agent — wired to
MeterPal's metered endpoint. Ask it for a chart and it reads the page, delegates,
places the widget, maps the data to the usage table, and the chart draws. Every one
of those turns is billed to the selected customer's wallet, and the header shows
the last turn's cost and the resulting balance.

**Why it is a genuine AG Grid claim, not a logo.** AG Grid's agent framework does
the work — `view_schema` / `view_report` / `view_page` / `delegate_to` /
`add_widget` / `configure_widget` are its tools, and the app supplies only the
model. The model is the metered one.

**Where the code is:**
| Path | What it is |
|---|---|
| `billing/vite/src/views/studio/StudioView.tsx` | the page: customer picker, metering banner, Reset |
| `billing/vite/src/views/studio/studioData.ts` | the AG Studio data source (one `usage` fact table) |
| `billing/vite/src/views/studio/studioAi.ts` | `createAiHarness` wired to the metered adapter |
| `billing/vite/src/views/studio/studioAdapter.ts` | `AgLlmAdapter` → `/studio/ai`, plus the `meterpal` block |
| `billing/vite/src/views/studio/studioReport.ts` | the seeded report (the starting widgets) |
| `billing/server/src/internal/studio/` | the metered turn, the data endpoint, the customers endpoint, and the AG Studio ⇄ OpenAI protocol |
| `demo/mock_agent.py` | the offline multi-agent policy (no provider keys needed) |
| `demo/test_mock_agent.py` | the offline test that locks the delegation chain down |

**Running it locally.** The studio reads through the billing server's own
analytics path, and the local **Postgres read path** means the whole thing works
with no cloud dependency: no Tinybird, no AG Grid server, no provider keys. The
agent turns run against the bundled mock LLM (`:9999`) through the LiteLLM proxy
(`:4000`), exactly like the rest of the demo.

**Verified end-to-end (Nov 10):** the agent's chain runs `view_schema →
view_report → view_page → delegate_to(page) → add_widget → complete_task →
delegate_to(widget) → configure_widget → complete_task`, the new "Credits by
feature" column chart renders real bars from the `usage` table, and the customer's
prepaid balance drops by exactly the sum of the turns' charges (8.89954 → 8.84006
across 10 metered turns, 0.05948 credits — the same number the event log records).

**Two things to fix before the recording.** Get an AG Studio license key (or plan
for the watermark), and run `demo/test_mock_agent.py` after any change to
`demo/mock_agent.py` — the agent protocol is easy to break silently, and a broken
chain shows up in the video as "no chart appeared".
