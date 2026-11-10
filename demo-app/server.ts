// demo-app/server.ts
//
// One process serving the demo app:
//   /api/autumn/*  — autumn-js backend routes (injects the billing secret
//                    key server-side; the browser never sees it)
//   /api/chat      — metered inference through the MeterPal SDK
//   /api/models    — the models this merchant serves, with their prices
//   /*             — the built frontend (vite build -> dist/)
//
// Run:  bun install && bun run dev   (builds, then serves on :5173)
// Env:  METERPAL_SECRET_KEY / METERPAL_API_URL — falls back to parsing
//       gateway/.env (demo convenience).

import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { autumnHandler } from "autumn-js/hono";
import { createMeterPal, InsufficientBalanceError } from "@meterpal/sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decideTopUp, type BuyerMandate, type Pack } from "./agent/mandate";
import {
	decideAgentAction,
	initialWatchState,
	type WatchState,
} from "./agent/watchdog";

const ROOT = import.meta.dir;

function readEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
	}
	return out;
}

function readGatewayEnv(): Record<string, string> {
	return readEnvFile(join(ROOT, "..", "gateway", ".env"));
}

const gatewayEnv = readGatewayEnv();
const SECRET_KEY =
	process.env.METERPAL_SECRET_KEY ??
	gatewayEnv.PAB_API_KEY ??
	gatewayEnv.AUTUMN_API_KEY ??
	"";
const API_URL = process.env.METERPAL_API_URL ?? "http://localhost:8080";

if (!SECRET_KEY) {
	console.error(
		"demo-app: no billing secret key — set METERPAL_SECRET_KEY or run demo/bootstrap.py to fill gateway/.env",
	);
}

// The inference client.  The secret key stays here, on the server; the
// browser only ever talks to /api/chat.
const meterpal = createMeterPal({
	apiKey: SECRET_KEY,
	baseURL: API_URL,
});

// ---- customer identity: server-issued, HMAC-signed tokens ----
// The browser can never claim an arbitrary customer id.  Identity is a token
// this server mints — `<id>.<HMAC>` — for the allowlisted demo personas only,
// signed with a key derived from the secret key (so tokens survive restarts
// but cannot be forged or enumerated for any other customer).  Every
// customer-scoped route verifies the signature server-side; a raw id in the
// header is rejected.
const DEMO_CUSTOMERS = (
	process.env.DEMO_CUSTOMER_IDS ?? "demo-customer,demo-customer-2"
)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const CUSTOMER_TOKEN_KEY = createHmac("sha256", SECRET_KEY).update(
	"meterpal-demo-customer-tokens",
).digest();

function signCustomerToken(customerId: string): string {
	const id = Buffer.from(customerId, "utf8").toString("base64url");
	const sig = createHmac("sha256", CUSTOMER_TOKEN_KEY)
		.update(customerId)
		.digest("base64url");
	return `${id}.${sig}`;
}

function verifyCustomerToken(raw: string | undefined): string | null {
	if (!raw) return null;
	const dot = raw.indexOf(".");
	if (dot <= 0) return null;
	let customerId: string;
	try {
		customerId = Buffer.from(raw.slice(0, dot), "base64url").toString("utf8");
	} catch {
		return null;
	}
	if (!customerId) return null;
	const expected = createHmac("sha256", CUSTOMER_TOKEN_KEY)
		.update(customerId)
		.digest();
	const given = Buffer.from(raw.slice(dot + 1), "base64url");
	if (given.length !== expected.length) return null;
	if (!timingSafeEqual(given, expected)) return null;
	return customerId;
}

/** The customer for this request — 401 unless a valid signed token is presented. */
function requireCustomer(c: { req: { header(name: string): string | undefined } }): string {
	const customerId = verifyCustomerToken(c.req.header("x-meterpal-customer"));
	if (!customerId) {
		throw new HTTPException(401, {
			message: "missing or invalid customer token — fetch GET /api/customer-tokens",
		});
	}
	return customerId;
}

// One gate in front of every customer-scoped route (the autumn proxy
// included), so no route can regress to trusting a raw id.
const requireCustomerMiddleware = async (c: {
	req: { header(name: string): string | undefined };
}, next: () => Promise<void>) => {
	requireCustomer(c);
	await next();
};

const app = new Hono();

// The demo personas the browser may hold tokens for.  Issuance is the trust
// boundary: anything not on this list is never signed.
app.get("/api/customer-tokens", (c) => {
	const tokens: Record<string, string> = {};
	for (const id of DEMO_CUSTOMERS) tokens[id] = signCustomerToken(id);
	return c.json({ customers: DEMO_CUSTOMERS, tokens });
});

// ---- usage read ----
// The usage panel reads the billing server's real events API through the
// autumn-js adapter below (`/api/autumn/listEvents`). It used to be overridden
// here with a direct Postgres read, because the server's events API
// aggregated through Tinybird -- a cloud analytics backend that is not part
// of the local stack. The server now serves the same contracts from Postgres
// when Tinybird is unconfigured, so there is one read path and the demo app
// and the merchant dashboard cannot drift apart.
let billingSql: Bun.SQL | null = null;
function getBillingSql(): Bun.SQL {
	if (!billingSql) {
		const url =
			process.env.METERPAL_DATABASE_URL ??
			readEnvFile(join(ROOT, "..", "billing", "server", ".env")).DATABASE_URL;
		if (!url) throw new Error("no billing DATABASE_URL for local usage read");
		billingSql = new Bun.SQL(url);
	}
	return billingSql;
}


// ---- billing routes (secret key injected here, server-side) ----
app.all(
	"/api/autumn/*",
	requireCustomerMiddleware,
	autumnHandler({
		identify: (c) => ({
			customerId: requireCustomer(c),
		}),
		secretKey: SECRET_KEY,
		autumnURL: process.env.METERPAL_API_URL ?? "http://localhost:8080",
	}),
);

// ---- paypal in-page checkout support ----
// The client id is public (sandbox) — the SDK loads it in the browser; the
// capture call is proxied so nothing but the order id crosses the wire.
app.get("/api/paypal/config", async (c) => {
	const clientId =
		process.env.PAYPAL_CLIENT_ID ??
		readEnvFile(join(ROOT, "..", "billing", "server", ".env")).PAYPAL_CLIENT_ID;
	return c.json({ clientId: clientId ?? null });
});

app.post("/api/paypal/capture/:orderId", async (c) => {
	const orderId = c.req.param("orderId");
	const base = process.env.METERPAL_API_URL ?? "http://localhost:8080";
	const res = await fetch(`${base}/paypal/capture/${encodeURIComponent(orderId)}`, {
		method: "POST",
	});
	const data = await res.json();
	// Normalize the billing server's `{ status: "captured", credits }` into
	// the SDK capture contract `{ captured: true, credits }` so the TopUpModal
	// treats a successful capture as success.
	return c.json({
		captured: data?.status === "captured",
		credits: data?.credits,
		status: data?.status,
	});
});

// ---- paypal poll proxy (popup checkout finalize) ----
app.get("/api/paypal/poll", async (c) => {
	const customerId = requireCustomer(c);
	const base = process.env.METERPAL_API_URL ?? "http://localhost:8080";
	const res = await fetch(
		`${base}/paypal/poll?customer_id=${encodeURIComponent(customerId)}`,
	);
	return c.json(await res.json());
});

// ---- metered chat, through the MeterPal SDK ----
app.post("/api/chat", async (c) => {
	const { prompt, model } = await c.req.json<{
		prompt?: string;
		model?: string;
	}>();
	if (!prompt) return c.json({ error: "prompt required" }, 400);

	const customerId = requireCustomer(c);

	try {
		const completion = await meterpal.chat.completions.create({
			// A model id from the merchant's served catalog.
			model: model ?? process.env.DEMO_MODEL_ID ?? "custom/demo-gpt",
			messages: [{ role: "user", content: prompt }],
			// The end user being billed.
			user: customerId,
		});
		// That call may have taken the wallet to zero.  Check right now
		// instead of waiting for the next watchdog tick, so the agent's
		// top-up ask is already up before the customer sends their next
		// message.
		void watchBuyerAgent(customerId).catch(() => {});
		return c.json(completion);
	} catch (error) {
		// The paywall: the end user must buy credits before the model runs.
		if (error instanceof InsufficientBalanceError) {
			const paywall = {
				error: "insufficient_balance",
				message: error.message,
				customer_id: error.customerId,
				balance: error.balance,
				requiredCredits: error.requiredCredits,
			};

			// The buyer agent gets the 402 first: if the customer gave their AI
			// a mandate, the agent decides — buy now (≤ auto-approve line,
			// PayPal still gates the payment), draft an authorization above the
			// line, or stand down at the budget.  Without a mandate this is the
			// plain paywall.
			try {
				const customer = await getCustomer(customerId);
				const mandate = customer?.metadata?.buyer_agent_mandate as
					| BuyerMandate
					| undefined;
				if (mandate?.enabled) {
					// The agent may already be mid-ask: the watchdog fires when
					// the credits run out, so by the time the customer sends
					// the message that got refused, a PayPal checkout can
					// already be waiting.  Reuse that ask instead of opening a
					// second one for the same wallet.
					const pending = customer?.metadata?.pending_agent_checkout as
						| PendingAgentCheckout
						| undefined;
					if (pending?.url) {
						return c.json(
							{
								...paywall,
								agent_action: "initiated",
								agent_reason: pending.reason,
								agent_pack: {
									product_id: pending.product_id,
									credits: pending.credits,
									price_usd: pending.price_usd,
								},
								checkout: {
									product_id: pending.product_id,
									url: pending.url,
								},
							},
							402,
						);
					}

					const outcome = await runBuyerAgent({
						customerId,
						mandate,
						requiredCredits: error.requiredCredits ?? ADMISSION_FLOOR_CREDITS,
						balance: error.balance ?? 0,
					});

					return c.json(
						{
							...paywall,
							agent_action: outcome.action,
							agent_reason: outcome.reason,
							...(outcome.pack ? { agent_pack: outcome.pack } : {}),
							...(outcome.checkout ? { checkout: outcome.checkout } : {}),
							...(outcome.proposal_id
								? { proposal_id: outcome.proposal_id }
								: {}),
						},
						402,
					);
				}
			} catch (agentError) {
				console.error(
					`buyer-agent decision failed for ${customerId}: ${agentError}`,
				);
				// Fall through to the plain paywall — the agent never blocks it.
			}

			return c.json(paywall, 402);
		}
		throw error;
	}
});

// ---- the merchant's served catalog ----
app.get("/api/models", async (c) => {
	const catalog = await meterpal.models.list();
	return c.json({
		models: catalog.models.map((model) => ({
			model_id: model.model_id,
			display_name: model.display_name,
			enabled: model.enabled,
			input_cost_usd_1m: model.input_cost_usd_1m,
			output_cost_usd_1m: model.output_cost_usd_1m,
		})),
	});
});

// ---- the buyer agent: mandate, spend math, and the 402 decision ----
// The agent runs HERE, in the merchant's app — the same place the MeterPal
// SDK lives.  Mandate lives in the customer's metadata on the billing server;
// spend math comes from this app's direct events read (the established local
// pattern above).

/** The packs this merchant sells — the buyer agent may only buy these.
 *  (The same ids the Top-up section offers; prices are 1:1 credits→USD,
 *  matching bootstrap.py's catalog.) */
const TOPUP_PACKS: Pack[] = [
	{ product_id: "topup_10", credits: 10, price_usd: 10 },
	{ product_id: "topup_50", credits: 50, price_usd: 50 },
	{ product_id: "topup_200", credits: 200, price_usd: 200 },
];

/** The credits a call needs before admission lets it through.  Used when the
 *  agent acts on its own and there is no 402 to read the floor from. */
const ADMISSION_FLOOR_CREDITS = 0.5;

type BuyerAgentOutcome = {
	action: "initiated" | "approval_required" | "denied";
	reason: string;
	pack: Pack | null;
	checkout?: { product_id: string; url: string | null };
	proposal_id?: string | null;
};

/**
 * The buyer agent's one action: decide, then act.
 *
 * Shared by the two triggers — the 402 (the customer spent again) and the
 * watchdog (the credits ran out) — so both take exactly the same decision
 * and open exactly one checkout.
 */
async function runBuyerAgent({
	customerId,
	mandate,
	requiredCredits,
	balance,
}: {
	customerId: string;
	mandate: BuyerMandate;
	requiredCredits: number;
	balance: number;
}): Promise<BuyerAgentOutcome> {
	const { monthSpend, burnRatePerDay, baselineDaily } =
		await getSpendSignals(customerId);
	const decision = decideTopUp({
		mandate,
		monthSpend,
		packs: TOPUP_PACKS,
		requiredCredits,
		// Observe the real situation, not just this call's shortfall: an
		// overdrawn wallet and a few days of steady burn decide how big a
		// pack the agent buys.
		usage: { balance, burnRatePerDay, baselineDaily },
	});

	if (decision.action === "initiate" && decision.pack) {
		const checkout = await billingApi<any>("POST", "/checkout", {
			customer_id: customerId,
			product_id: decision.pack.product_id,
		});
		// Mirror the checkout into customer metadata: the chat paywall card
		// dies with the message list (refresh, customer switch), and the
		// human-in-the-loop ask must survive it.
		if (checkout?.url) {
			await setPendingAgentCheckout(customerId, {
				product_id: decision.pack.product_id,
				credits: decision.pack.credits,
				price_usd: decision.pack.price_usd,
				reason: decision.reason,
				url: checkout.url,
				created_at: Date.now(),
			}).catch((err) =>
				console.error(
					`pending-checkout mirror failed for ${customerId}: ${err}`,
				),
			);
		}
		return {
			action: "initiated",
			reason: decision.reason,
			pack: decision.pack,
			checkout: {
				product_id: decision.pack.product_id,
				url: checkout?.url ?? null,
			},
		};
	}

	if (decision.action === "ask" && decision.pack) {
		const { proposal } = await billingApi<any>(
			"POST",
			"/sales-agent/authorize-topup",
			{
				customer_id: customerId,
				product_id: decision.pack.product_id,
				credits: decision.pack.credits,
				price_usd: decision.pack.price_usd,
				reason: decision.reason,
			},
		);
		return {
			action: "approval_required",
			reason: decision.reason,
			pack: decision.pack,
			proposal_id: proposal?.id ?? null,
		};
	}

	return { action: "denied", reason: decision.reason, pack: null };
}

// ---- the buyer agent watches the wallet ----
//
// The agent used to wait for a 402, which made it reactive: the customer
// had to spend again before their wallet was topped up, and a customer who
// stopped using the product was never topped up at all.  The watchdog
// watches the wallet and fires the moment the credits run out — so the
// top-up ask is already waiting when the customer comes back, and a
// customer who never comes back is still topped up.

const AGENT_WATCH_INTERVAL_MS = 4000;
const agentWatchStates = new Map<string, WatchState>();
const agentWatchErrors = new Map<string, number>();

/**
 * The core's depletion marker, read straight from Postgres: the customer's
 * cached subject can be a few seconds behind the write, and the whole point
 * of the marker is to be exact about WHEN the credits ran out.
 */
async function readDepletionMarker(customerId: string): Promise<number | null> {
	try {
		const sql = getBillingSql();
		const rows = await sql`
			select metadata->'balance_depleted' as depleted
			from customers
			where id = ${customerId}
				and env = 'sandbox'
			limit 1
		`;
		const raw = rows[0]?.depleted;
		if (!raw) return null;
		const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
		return parsed?.at ? Number(parsed.at) : null;
	} catch (err) {
		console.error(`depletion marker read failed for ${customerId}: ${err}`);
		return null;
	}
}

async function watchBuyerAgent(customerId: string): Promise<void> {
	const customer = await getCustomer(customerId);
	const mandate = customer?.metadata?.buyer_agent_mandate as
		| BuyerMandate
		| undefined;
	const featureId = process.env.METERPAL_FEATURE_ID ?? "ai_tokens";
	const balance = Number(
		(customer?.balances as any)?.[featureId]?.remaining ?? 0,
	);
	const pending = Boolean(
		(customer?.metadata?.pending_agent_checkout as PendingAgentCheckout | undefined)
			?.url,
	);
	const depletionAt = await readDepletionMarker(customerId);
	const state = agentWatchStates.get(customerId) ?? initialWatchState();

	const decision = decideAgentAction({
		balance,
		mandateEnabled: Boolean(mandate?.enabled),
		pendingCheckout: pending,
		depletionAt,
		state,
	});
	agentWatchStates.set(customerId, decision.state);

	if (decision.action !== "fire" || !mandate?.enabled) return;

	console.log(
		`buyer agent acting on ${customerId}: ${decision.reason} (balance ${balance})`,
	);
	await runBuyerAgent({
		customerId,
		mandate,
		requiredCredits: ADMISSION_FLOOR_CREDITS,
		balance,
	});
}

async function watchBuyerAgents(): Promise<void> {
	for (const customerId of DEMO_CUSTOMERS) {
		try {
			await watchBuyerAgent(customerId);
		} catch (err) {
			// Throttle: the billing server being down should not fill the log.
			const last = agentWatchErrors.get(customerId) ?? 0;
			if (Date.now() - last > 30_000) {
				agentWatchErrors.set(customerId, Date.now());
				console.error(
					`buyer-agent watchdog failed for ${customerId}: ${err}`,
				);
			}
		}
	}
}

setInterval(() => {
	void watchBuyerAgents();
}, AGENT_WATCH_INTERVAL_MS);

async function billingApi<T = any>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${API_URL}/v1${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${SECRET_KEY}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	const data = text ? JSON.parse(text) : null;
	if (!res.ok) {
		throw new Error(`billing ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
	}
	return data as T;
}

async function getCustomer(customerId: string): Promise<any> {
	return await billingApi(
		"GET",
		`/customers/${encodeURIComponent(customerId)}?expand=balances.feature`,
	);
}

/** Both numbers the buyer agent needs, from the same ledger in one read:
 *  calendar-month spend (enforces the budget) and trailing-24h burn (shown
 *  for context).  Credits are 1:1 with USD in this demo's price sheet.
 *
 *  The baseline (the trailing-7-day daily average, excluding the last 24h)
 *  is what the agent actually sizes the purchase on — one outsized call
 *  must not decide how many credits the customer buys next. */
async function getSpendSignals(
	customerId: string,
): Promise<{
	monthSpend: number;
	burnRatePerDay: number;
	baselineDaily: number;
}> {
	const now = new Date();
	const monthStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
	);
	const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const weekAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
	const sql = getBillingSql();
	const feature = process.env.METERPAL_FEATURE_ID ?? "ai_tokens";

	// The month window and the burn window differ: the baseline needs the
	// days BEFORE this month, so it cannot be clamped to the month start.
	const [monthRows, burnRows] = await Promise.all([
		sql`
			select coalesce(sum(value), 0) as month_spend
			from events
			where env = 'sandbox'
				and event_name = ${feature}
				and customer_id = ${customerId}
				and "timestamp" >= ${monthStart.toISOString()}
		`,
		sql`
			select
				coalesce(
					sum(value) filter (where "timestamp" >= ${last24h.toISOString()}),
					0
				) as burn,
				coalesce(
					sum(value) filter (where "timestamp" < ${last24h.toISOString()}),
					0
				) as prior_week
			from events
			where env = 'sandbox'
				and event_name = ${feature}
				and customer_id = ${customerId}
				and "timestamp" >= ${weekAgo.toISOString()}
		`,
	]);

	return {
		monthSpend: Number(monthRows[0]?.month_spend ?? 0),
		burnRatePerDay: Number(burnRows[0]?.burn ?? 0),
		baselineDaily: Number(burnRows[0]?.prior_week ?? 0) / 7,
	};
}

app.get("/api/agent-settings", async (c) => {
	const customerId = requireCustomer(c);
	const customer = await getCustomer(customerId);
	let insights: any = null;
	try {
		insights = await billingApi(
			"GET",
			`/sales-agent/insights?customer_id=${encodeURIComponent(customerId)}`,
		);
	} catch {
		// The panel still renders with mandate + balance if insights fail.
	}
	const aiTokens = customer?.balances?.ai_tokens ?? {};
	return c.json({
		mandate: customer?.metadata?.buyer_agent_mandate ?? null,
		balance: aiTokens.remaining ?? null,
		granted: aiTokens.max ?? aiTokens.granted ?? null,
		insights,
	});
});

app.post("/api/agent-settings", async (c) => {
	const customerId = requireCustomer(c);
	const body = await c.req.json().catch(() => ({}) as any);
	const mandate = body?.mandate;
	if (
		!mandate ||
		typeof mandate !== "object" ||
		typeof mandate.enabled !== "boolean" ||
		![mandate.max_per_purchase, mandate.monthly_budget, mandate.auto_approve_below].every(
			(v: any) => typeof v === "number" && v >= 0,
		)
	) {
		return c.json({ error: "invalid mandate" }, 400);
	}
	// Metadata merges shallowly per key, so replacing this one key is safe.
	const customer = await billingApi("POST", `/customers/${encodeURIComponent(customerId)}`, {
		metadata: { buyer_agent_mandate: mandate },
	});
	return c.json({ mandate: customer?.metadata?.buyer_agent_mandate ?? mandate });
});

// ---- pending agent checkout: the durable "approve in PayPal" signal ----
// When the buyer agent opens a checkout on a 402, the approval link is
// mirrored into customer metadata so the app can keep asking for the human
// approval until PayPal settles the order one way or the other.
type PendingAgentCheckout = {
	product_id: string;
	credits: number;
	price_usd: number;
	reason: string;
	url: string;
	created_at: number;
};

async function setPendingAgentCheckout(
	customerId: string,
	record: PendingAgentCheckout | null,
): Promise<void> {
	await billingApi("POST", `/customers/${encodeURIComponent(customerId)}`, {
		// Metadata merges per key and null deletes the key, so the mandate
		// (and everything else) is untouched.
		metadata: { pending_agent_checkout: record },
	});
}

app.get("/api/agent/pending-checkout", async (c) => {
	const customerId = requireCustomer(c);
	const customer = await getCustomer(customerId);
	const record = customer?.metadata?.pending_agent_checkout as
		| PendingAgentCheckout
		| undefined;
	if (!record?.url) return c.json({ pending: false });

	// Ask PayPal which way the order went.  The poll also captures an
	// approved-but-uncaptured order (idempotent), so an approval that lands
	// while the user is on another tab still grants credits.
	try {
		const res = await fetch(
			`${API_URL}/paypal/poll?customer_id=${encodeURIComponent(customerId)}`,
		);
		const poll = await res.json();
		if (poll?.status === "pending") {
			return c.json({ pending: true, checkout: record });
		}
		// Captured, abandoned, or already granted through another path — the
		// checkout is settled, so stop asking.
		await setPendingAgentCheckout(customerId, null);
		return c.json({
			pending: false,
			captured: poll?.status === "captured",
			credits: poll?.credits,
		});
	} catch {
		// Billing unreachable — keep the ask alive; it re-checks next tick.
		return c.json({ pending: true, checkout: record });
	}
});

app.delete("/api/agent/pending-checkout", async (c) => {
	const customerId = requireCustomer(c);
	await setPendingAgentCheckout(customerId, null);
	return c.json({ ok: true });
});

// ---- sales-rep agent proxy (negotiation + offers) ----

app.post("/api/sales/chat", async (c) => {
	const customerId = requireCustomer(c);
	const body = await c.req.json().catch(() => ({}) as any);
	if (!body?.message) return c.json({ error: "message required" }, 400);
	const res = await fetch(`${API_URL}/v1/sales-agent/chat`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${SECRET_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			customer_id: customerId,
			message: body.message,
			history: Array.isArray(body.history) ? body.history.slice(-30) : [],
		}),
	});
	return c.json(await res.json(), res.status as any);
});

app.get("/api/sales/offers", async (c) => {
	const customerId = requireCustomer(c);
	const res = await fetch(
		`${API_URL}/v1/sales-agent/offers?customer_id=${encodeURIComponent(customerId)}`,
		{ headers: { Authorization: `Bearer ${SECRET_KEY}` } },
	);
	return c.json(await res.json(), res.status as any);
});

for (const action of ["decline", "purchased"] as const) {
	app.post(`/api/sales/proposals/:id/${action}`, async (c) => {
		requireCustomer(c);
		const proposalId = c.req.param("id");
		const res = await fetch(
			`${API_URL}/v1/sales-agent/proposals/${encodeURIComponent(proposalId)}/${action}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${SECRET_KEY}` },
			},
		);
		return c.json(await res.json(), res.status as any);
	});
}

// ---- static frontend ----
const dist = join(ROOT, "dist");
app.use("/*", serveStatic({ root: "dist", rewriteRequestPath: (p) => p }));
app.get("*", serveStatic({ path: join(dist, "index.html") }));

const port = Number(process.env.PORT ?? 5173);
console.log(
	`meterpal demo-app: http://localhost:${port} (signed-identity customers: ${DEMO_CUSTOMERS.join(", ")})`,
);
Bun.serve({ port, fetch: app.fetch });
