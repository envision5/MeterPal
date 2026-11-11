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
import {
	createMeterPal,
	InsufficientBalanceError,
	type ChatCompletionChunk,
} from "@meterpal/sdk";
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

// ---- the binding: which merchant this demo is showing ----
// demo/bind.py writes demo-app/.binding.json so the org the merchant set up in
// the dashboard is, by construction, the org this app bills. Without it the two
// halves drift apart and every screen looks broken for the wrong reason.
type Binding = {
	api_url?: string;
	org?: { id: string; slug: string; name: string };
	feature_id?: string;
	model_id?: string;
	customers?: string[];
	plans?: string[];
	topups?: { id: string; label: string; price: number }[];
};

const BINDING_JSON = join(ROOT, ".binding.json");

function readBinding(): Binding | null {
	if (!existsSync(BINDING_JSON)) return null;
	try {
		return JSON.parse(readFileSync(BINDING_JSON, "utf8")) as Binding;
	} catch {
		return null;
	}
}

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

// ---- which merchant is this? ----
// The org, feature and model come from the binding; the top-up row is re-read
// live so a price change in the dashboard shows up on the next reload instead
// of drifting from what the merchant just edited.
app.get("/api/config", async (c) => {
	const binding = readBinding();
	let topups = binding?.topups ?? [];

	try {
		const res = await fetch(`${API_URL}/v1/plans`, {
			headers: { Authorization: `Bearer ${SECRET_KEY}` },
		});
		if (res.ok) {
			const { list = [] } = (await res.json()) as { list: any[] };
			const allow = process.env.DEMO_TOPUP_PRODUCT_IDS
				? process.env.DEMO_TOPUP_PRODUCT_IDS.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: null;
			const live = list
				.filter((p) => p.add_on && !p.archived)
				.filter((p) =>
					// pkg_* are agent-negotiated volume packs: they belong in the
					// Offers tab, not in the fixed top-up buttons.
					allow ? allow.includes(p.id) : !String(p.id).startsWith("pkg_"),
				)
				.map((p) => ({
					id: p.id,
					label: p.name ?? p.id,
					price: Number(p.items?.[0]?.price?.amount ?? 0),
				}))
				.sort((a, b) => a.price - b.price);
			if (live.length) topups = live;
		}
	} catch {
		// Fall back to the snapshot in the binding.
	}

	return c.json({
		org: binding?.org ?? null,
		feature_id: binding?.feature_id ?? process.env.METERPAL_FEATURE_ID ?? null,
		model_id: binding?.model_id ?? process.env.DEMO_MODEL_ID ?? "custom/demo-gpt",
		customers: DEMO_CUSTOMERS,
		topups,
		// The merchant's setting, so the app can say how it will answer
		// instead of the user discovering it from the response headers.
		streaming: (await getChatConfig()).streaming,
	});
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

/**
 * The customer's wallet, in the numbers that differ from each other.
 *
 * `settled` is the one a human should be shown as "credits", and it is NOT
 * the raw balance.  A metered call reserves its worst-case price before the
 * model runs, and that reservation is a real deduction on the balance row
 * until the call settles — so the raw balance leaps down by the reservation
 * the moment a call starts and springs back when it ends.  Read raw, the
 * wallet looks like it is playing catch with itself, and a customer with
 * healthy credits trips the "almost empty" warning on the way past.
 *
 * The billing server owns that arithmetic (it is the only place that can
 * tell a reservation from a charge), and returns it as `settled`.  This app
 * therefore never computes a balance itself: it asks, and shows what it is
 * told.  `balance` is still returned for the paywall, because that is the
 * figure admission control actually gates on.
 */
type Wallet = {
	/** Spendable right now — reservations already deducted. */
	balance: number;
	/** Reserved by calls in flight. */
	held: number;
	/** What the customer has spent down to. The number on screen. */
	settled: number;
	/** Everything granted, for the progress bar's denominator. */
	granted: number;
	held_calls: number;
};

async function getWallet(
	customerId: string,
	featureId: string,
): Promise<Wallet | null> {
	try {
		return await billingApi<Wallet>(
			"GET",
			`/wallet?customer_id=${encodeURIComponent(customerId)}&feature_id=${encodeURIComponent(featureId)}`,
		);
	} catch (err) {
		console.error(`wallet read failed for ${customerId}: ${err}`);
		return null;
	}
}

// ---- the merchant's chat settings ----
// Whether responses stream is the MERCHANT's decision, edited in the
// dashboard's Settings -> Chat.  Read through the billing server so the two
// halves cannot disagree; cached briefly because it changes only when the
// merchant saves, and every chat turn would otherwise pay for a round trip.
type ChatConfig = { streaming: boolean };
let chatConfigCache: { value: ChatConfig; at: number } = {
	value: { streaming: true },
	at: 0,
};
const CHAT_CONFIG_TTL_MS = 5_000;

async function getChatConfig(): Promise<ChatConfig> {
	if (Date.now() - chatConfigCache.at < CHAT_CONFIG_TTL_MS) {
		return chatConfigCache.value;
	}
	try {
		const value = await billingApi<ChatConfig>("GET", "/chat-config");
		chatConfigCache = {
			value: { streaming: value?.streaming !== false },
			at: Date.now(),
		};
	} catch {
		// Keep the last known value.  A billing outage must not silently
		// change how the app answers; the shipped default is streaming on.
		chatConfigCache = { ...chatConfigCache, at: Date.now() };
	}
	return chatConfigCache.value;
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
	const env = readEnvFile(join(ROOT, "..", "billing", "server", ".env"));
	const clientId = process.env.PAYPAL_CLIENT_ID ?? env.PAYPAL_CLIENT_ID;
	// The sandbox BUYER account that approves payments, when the operator
	// names it.  Approval is deliberately manual -- the agent can open a
	// checkout but never approve one -- and the approval screen is the one
	// place a judge has to log in, so the account is worth naming on screen
	// instead of leaving "log in there" to guesswork.
	const buyer = process.env.DEMO_PAYPAL_BUYER ?? env.DEMO_PAYPAL_BUYER ?? null;
	return c.json({ clientId: clientId ?? null, buyer: buyer ?? null });
});

app.post("/api/paypal/capture/:orderId", async (c) => {
	// Customer-scoped like every other money route: the order id alone used to
	// be enough to trigger a capture from any page. Billing checks the order's
	// owner against the id we assert here.
	const customerId = requireCustomer(c);
	const orderId = c.req.param("orderId");
	const base = process.env.METERPAL_API_URL ?? "http://localhost:8080";
	const res = await fetch(
		`${base}/paypal/capture/${encodeURIComponent(orderId)}?customer_id=${encodeURIComponent(customerId)}`,
		{ method: "POST" },
	);
	const data = await res.json();
	// Normalize the billing server's `{ status: "captured", credits }` into
	// the SDK capture contract `{ captured: true, credits }` so the TopUpModal
	// treats a successful capture as success.  A refusal keeps its status:
	// flattening a 429 into a 200 with `captured: false` made "we were told to
	// slow down" indistinguishable from "PayPal has not approved this yet".
	return c.json(
		{
			captured: data?.status === "captured",
			credits: data?.credits,
			status: data?.status,
			...(res.ok ? {} : { error: data?.error ?? "capture_failed" }),
		},
		res.ok ? 200 : (res.status as 200),
	);
});

// ---- paypal poll proxy (popup checkout finalize) ----
//
// ONE upstream call, many readers.
//
// Two UI loops watch the same order: the "waiting for approval" ticker (2s)
// and the durable banner (4s). Each used to spend its own request, so the pair
// burned ~45/min against a per-customer budget of 30 -- and billing answers a
// refusal with `{ error: "rate_limited" }`, which is indistinguishable from
// "settled" to any caller that only reads `status`. That combination deleted
// the pending-approval mirror mid-checkout: the order was still live at PayPal,
// the banner was gone, and the approval link did not survive the next reload.
//
// So the proxy owns the polling. Concurrent readers share one in-flight
// request and a short TTL cache answers the rest, which keeps upstream load at
// ~24/min no matter how many loops the page runs. The status code is propagated
// rather than flattened to 200, so a refusal can never be mistaken for an
// answer.
const POLL_TTL_MS = 2_500;

type PollAnswer = { ok: boolean; status: number; body: Record<string, unknown> };

const pollInFlight = new Map<string, Promise<PollAnswer>>();
const pollCache = new Map<string, { at: number; answer: PollAnswer }>();

async function pollUpstream(customerId: string): Promise<PollAnswer> {
	const cached = pollCache.get(customerId);
	if (cached && Date.now() - cached.at < POLL_TTL_MS) return cached.answer;

	const inFlight = pollInFlight.get(customerId);
	if (inFlight) return inFlight;

	const request = (async (): Promise<PollAnswer> => {
		try {
			const res = await fetch(
				`${API_URL}/paypal/poll?customer_id=${encodeURIComponent(customerId)}`,
			);
			let body: Record<string, unknown> = {};
			try {
				body = (await res.json()) as Record<string, unknown>;
			} catch {
				body = {};
			}
			return { ok: res.ok, status: res.status, body };
		} catch {
			// Billing unreachable is NOT a settled checkout.
			return { ok: false, status: 0, body: { error: "unreachable" } };
		} finally {
			pollInFlight.delete(customerId);
		}
	})();

	pollInFlight.set(customerId, request);
	const answer = await request;
	pollCache.set(customerId, { at: Date.now(), answer });
	return answer;
}

/** A capture or an explicit "nothing pending" is a real answer; nothing else is. */
const pollSettled = (answer: PollAnswer) =>
	answer.ok &&
	(answer.body.status === "captured" || answer.body.status === "none");

/**
 * A status Hono will accept.
 *
 * `pollUpstream` reports an unreachable billing server as status 0, which is
 * the right internal signal -- it is not an HTTP answer at all -- but Hono
 * throws on `c.json(body, 0)`, so the unreachable branch answered 500 with a
 * stack trace instead of a clean 503. The caller only ever branches on
 * `res.ok`, so mapping 0 to 503 keeps the signal and makes the response valid.
 */
const httpStatus = (status: number): 200 | 503 =>
	status >= 200 && status <= 599 ? (status as 200) : 503;

app.get("/api/paypal/poll", async (c) => {
	const customerId = requireCustomer(c);
	const answer = await pollUpstream(customerId);
	return c.json(answer.body, httpStatus(answer.status));
});

// ---- metered chat, through the MeterPal SDK ----
//
// Two delivery modes, and the MERCHANT picks which one (dashboard ->
// Settings -> Chat):
//
//   streamed   tokens forwarded as the gateway produces them, then one final
//              event carrying the charge.  The first words land in
//              milliseconds, and the wallet visibly drains while the call is
//              in flight.
//   whole      the completed response in one JSON payload.
//
// Admission control runs before the model does, so the 402 paywall is
// identical either way: a refusal is a refusal whether or not the caller
// asked for a stream, and there is never a half-written response to
// reconcile.

/**
 * The paywall, with the buyer agent's decision attached.
 *
 * Shared by both delivery modes: the agent must reach the same conclusion
 * whether or not the caller asked for a stream.
 */
async function buildPaywall(
	customerId: string,
	error: InsufficientBalanceError,
): Promise<Record<string, unknown>> {
	const paywall = {
		error: "insufficient_balance",
		message: error.message,
		customer_id: error.customerId,
		balance: error.balance,
		requiredCredits: error.requiredCredits,
	};

	// The buyer agent gets the 402 first: if the customer gave their AI a
	// mandate, the agent decides — buy now (≤ auto-approve line, PayPal still
	// gates the payment), draft an authorization above the line, or stand
	// down at the budget.  Without a mandate this is the plain paywall.
	try {
		const customer = await getCustomer(customerId);
		const mandate = await resolveBuyerMandate(customer);
		if (!mandate?.enabled) return paywall;

		// The agent may already be mid-ask: the watchdog fires when the
		// credits run out, so by the time the customer sends the message that
		// got refused, a PayPal checkout can already be waiting.  Reuse that
		// ask instead of opening a second one for the same wallet.
		const pending = customer?.metadata?.pending_agent_checkout as
			| PendingAgentCheckout
			| undefined;
		if (pending?.url) {
			return {
				...paywall,
				agent_action: "initiated",
				agent_reason: pending.reason,
				agent_pack: {
					product_id: pending.product_id,
					credits: pending.credits,
					price_usd: pending.price_usd,
				},
				checkout: { product_id: pending.product_id, url: pending.url },
			};
		}

		const outcome = await runBuyerAgent({
			customerId,
			mandate,
			requiredCredits: error.requiredCredits ?? ADMISSION_FLOOR_CREDITS,
			balance: error.balance ?? 0,
		});

		return {
			...paywall,
			agent_action: outcome.action,
			agent_reason: outcome.reason,
			...(outcome.pack ? { agent_pack: outcome.pack } : {}),
			...(outcome.checkout ? { checkout: outcome.checkout } : {}),
			...(outcome.proposal_id ? { proposal_id: outcome.proposal_id } : {}),
		};
	} catch (agentError) {
		console.error(
			`buyer-agent decision failed for ${customerId}: ${agentError}`,
		);
		// Fall through to the plain paywall — the agent never blocks it.
		return paywall;
	}
}

app.post("/api/chat", async (c) => {
	const { prompt, model, stream } = await c.req.json<{
		prompt?: string;
		model?: string;
		stream?: boolean;
	}>();
	if (!prompt) return c.json({ error: "prompt required" }, 400);

	const customerId = requireCustomer(c);

	const params = {
		// A model id from the merchant's served catalog.
		model: model ?? process.env.DEMO_MODEL_ID ?? "custom/demo-gpt",
		messages: [{ role: "user" as const, content: prompt }],
		// The end user being billed.
		user: customerId,
	};

	// The merchant's setting wins: a client may ask to stream, but it only
	// streams if the merchant turned streaming on.
	const wantsStream = stream !== false && (await getChatConfig()).streaming;
	if (wantsStream) {
		return await streamChat({ customerId, params });
	}

	try {
		const completion = await meterpal.chat.completions.create(params);
		// That call may have taken the wallet to zero.  Check right now
		// instead of waiting for the next watchdog tick, so the agent's
		// top-up ask is already up before the customer sends their next
		// message.
		void watchBuyerAgent(customerId).catch(() => {});
		return c.json(completion);
	} catch (error) {
		// The paywall: the end user must buy credits before the model runs.
		if (error instanceof InsufficientBalanceError) {
			return c.json(await buildPaywall(customerId, error), 402);
		}
		throw error;
	}
});

const SSE_HEADERS = {
	"Content-Type": "text/event-stream; charset=utf-8",
	// `no-transform` keeps a proxy from buffering the stream into one piece,
	// which would defeat the point of streaming.
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
};

/**
 * Stream one metered completion to the browser.
 *
 * The SDK hands back an async generator over the gateway's chunks.  The FIRST
 * pull is where the HTTP request is actually made — so the paywall still gets
 * to answer as plain JSON with a 402, instead of us committing to an event
 * stream we would then have to abort.  Only after a chunk has arrived do we
 * take over the response.
 *
 * Wire format, one JSON object per event:
 *   {"delta":"..."}    the next piece of text
 *   {"usage":{...}}    token counts, when the provider reports them
 *   {"meterpal":{...}} what the call cost — the wallet's next value
 *   [DONE]             end of stream
 *   {"error":"..."}    the call failed after the stream had started
 */
async function streamChat({
	customerId,
	params,
}: {
	customerId: string;
	params: { model: string; messages: { role: "user"; content: string }[]; user: string };
}): Promise<Response> {
	const chunks = meterpal.chat.completions.stream(params);

	let first: IteratorResult<ChatCompletionChunk, void>;
	try {
		first = await chunks.next();
	} catch (error) {
		if (error instanceof InsufficientBalanceError) {
			return Response.json(await buildPaywall(customerId, error), {
				status: 402,
			});
		}
		throw error;
	}

	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let closed = false;
			const send = (payload: unknown) => {
				if (closed) return;
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
				);
			};

			try {
				let step = first;
				while (!step.done) {
					const chunk = step.value as ChatCompletionChunk;
					// A chunk can carry text, usage, the meterpal block, or
					// several of them; forward whichever are present.
					const text = chunk?.choices?.[0]?.delta?.content;
					if (typeof text === "string" && text.length > 0) {
						send({ delta: text });
					}
					if (chunk?.usage) send({ usage: chunk.usage });
					if (chunk?.meterpal) send({ meterpal: chunk.meterpal });
					step = await chunks.next();
				}
				closed = true;
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			} catch (error) {
				// The response has already started, so the failure has to
				// travel inside the stream.
				send({ error: String(error) });
				closed = true;
				try {
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				} catch {
					// The client went away; nothing left to close.
				}
			} finally {
				// The charge may have taken the wallet to zero.  Same check
				// the non-streamed path runs, at the same moment.
				void watchBuyerAgent(customerId).catch(() => {});
			}
		},
		cancel() {
			// The browser hung up.  Stop reading the upstream stream; the call
			// still completes and is still billed, because the model ran.
			void chunks.return().catch(() => {});
		},
	});

	return new Response(body, { status: 200, headers: SSE_HEADERS });
}

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

/**
 * Which mandate governs this customer.
 *
 * A per-customer mandate is a deliberate instruction and always wins.
 * Otherwise the merchant's standing terms apply, so the agent exists out of
 * the box instead of being dead until someone writes per-customer metadata.
 */
async function resolveBuyerMandate(
	customer: any,
): Promise<BuyerMandate | undefined> {
	const perCustomer = customer?.metadata?.buyer_agent_mandate as
		| BuyerMandate
		| undefined;
	if (perCustomer) return perCustomer;
	return (await getOrgBuyerDefaults()) ?? undefined;
}

async function watchBuyerAgent(customerId: string): Promise<void> {
	const customer = await getCustomer(customerId);
	const mandate = await resolveBuyerMandate(customer);
	const featureId = process.env.METERPAL_FEATURE_ID ?? "ai_tokens";
	// The SETTLED balance, for the same reason the wallet shows it: a live
	// balance dips for the duration of a call in flight, and a dip is not an
	// empty wallet.  Topping up on a dip would spend the customer's money on a
	// request they never made.
	const wallet = await getWallet(customerId, featureId);
	const balance =
		wallet?.settled ??
		Number((customer?.balances as any)?.[featureId]?.remaining ?? 0);
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

/**
 * The merchant's standing terms for a customer's buying agent, as edited in
 * Settings -> Agent -> "Buyer agent defaults".
 *
 * These only apply when the customer has NOT set a mandate of their own: a
 * per-customer mandate is a deliberate instruction and always wins.  Cached
 * briefly because the watchdog ticks per customer and this changes only when
 * the merchant saves settings.
 */
let orgBuyerDefaults: { value: BuyerMandate | null; at: number } = {
	value: null,
	at: 0,
};
const ORG_DEFAULTS_TTL_MS = 60_000;

async function getOrgBuyerDefaults(): Promise<BuyerMandate | null> {
	if (
		orgBuyerDefaults.value &&
		Date.now() - orgBuyerDefaults.at < ORG_DEFAULTS_TTL_MS
	) {
		return orgBuyerDefaults.value;
	}
	try {
		const defaults = await billingApi<BuyerMandate>("GET", "/agent/buyer-defaults");
		orgBuyerDefaults = { value: defaults, at: Date.now() };
		return defaults;
	} catch (err) {
		// The ledger being unreachable must not invent a mandate.  Keep the
		// last known value (or none) and let the next tick retry.
		console.warn(`buyer agent: could not read merchant defaults: ${err}`);
		return orgBuyerDefaults.value;
	}
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
	//
	// Only the settled charges count.  A metered call also writes the
	// check-time reservation and its refund around it, both internal and
	// signed the wrong way to be a cost, and the reservation stays
	// outstanding for as long as the call runs.  Counting it would make the
	// agent size a purchase against spend that has not happened yet -- so
	// the settled event is the one carrying the idempotency key.
	const [monthRows, burnRows] = await Promise.all([
		sql`
			select coalesce(sum(value), 0) as month_spend
			from events
			where env = 'sandbox'
				and event_name = ${feature}
				and customer_id = ${customerId}
				and idempotency_key is not null
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
				and idempotency_key is not null
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
	const featureId = process.env.METERPAL_FEATURE_ID ?? "ai_tokens";
	// The wallet, as the customer should see it: what they have spent, not
	// what is currently held for a call in flight.  See getWallet.
	const wallet = await getWallet(customerId, featureId);

	// The mandate the AGENT will actually act on, not just the one stored on
	// this customer.  A customer with no mandate of their own inherits the
	// merchant's standing terms, and the agent buys under those -- so the
	// panel has to show them.  Reading only the per-customer key is what made
	// this screen say "Agent off — you handle top-ups" with empty budget
	// fields while the agent was auto-approving purchases against the org
	// default in the same second.
	const perCustomer = customer?.metadata?.buyer_agent_mandate as
		| BuyerMandate
		| undefined;
	const mandate = await resolveBuyerMandate(customer);
	const source: "customer" | "merchant-default" | "none" = perCustomer
		? "customer"
		: mandate
			? "merchant-default"
			: "none";

	return c.json({
		mandate: mandate ?? null,
		// Where the mandate came from, so the panel can say whether saving
		// writes this customer's own terms or overrides the merchant default.
		mandate_source: source,
		balance: wallet?.settled ?? aiTokens.remaining ?? null,
		granted: wallet?.granted ?? aiTokens.max ?? aiTokens.granted ?? null,
		held: wallet?.held ?? 0,
		insights,
	});
});

/**
 * The wallet on its own — the figure the header pill and the Wallet rail
 * poll.  Separate from /api/agent-settings because that route also computes
 * spend insights, which is far too much work to run every couple of seconds
 * just to move a number.
 *
 * `balance` here is the SETTLED figure, so a call in flight never makes it
 * dip: it steps down when the call's charge lands, and not before.
 */
app.get("/api/wallet", async (c) => {
	const customerId = requireCustomer(c);
	const featureId = process.env.METERPAL_FEATURE_ID ?? "ai_tokens";
	const wallet = await getWallet(customerId, featureId);
	if (!wallet) return c.json({ error: "wallet_unavailable" }, 503);

	// The mandate decides whether the app pre-opens PayPal on send.  It is
	// the RESOLVED mandate, not just the per-customer one: a customer with no
	// mandate of their own is governed by the merchant's standing terms, and
	// the agent acts on those.  Reading only the customer's own key made the
	// app's pre-open decision disagree with the agent's.
	let mandateEnabled = false;
	try {
		const mandate = await resolveBuyerMandate(await getCustomer(customerId));
		mandateEnabled = Boolean(mandate?.enabled);
	} catch {
		// No mandate flag: the app simply will not pre-open a popup.
	}

	return c.json({
		...wallet,
		month_spend: await getMonthSpend(customerId, featureId),
		mandate_enabled: mandateEnabled,
	});
});

/**
 * Calendar-month spend, from the settled ledger.
 *
 * Only events carrying an idempotency key are charges: the check-time
 * reservation and its refund are written around the call, both internal and
 * signed the wrong way to be a cost.  Counting them would double the figure
 * for the duration of every call.
 */
async function getMonthSpend(
	customerId: string,
	featureId: string,
): Promise<number | null> {
	try {
		const now = new Date();
		const monthStart = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		);
		const sql = getBillingSql();
		const rows = await sql`
			select coalesce(sum(value), 0) as month_spend
			from events
			where env = 'sandbox'
				and event_name = ${featureId}
				and customer_id = ${customerId}
				and idempotency_key is not null
				and "timestamp" >= ${monthStart.toISOString()}
		`;
		return Number(rows[0]?.month_spend ?? 0);
	} catch {
		return null;
	}
}

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
	//
	// The mirror is cleared ONLY on a real answer -- captured, or "nothing
	// pending".  A rate-limited poll, a 5xx, or an unreachable billing server
	// all mean "we don't know yet", and treating "we don't know" as "settled"
	// threw away the buyer's only route back to an approval that was still
	// live at PayPal.
	const answer = await pollUpstream(customerId);
	if (!pollSettled(answer)) {
		return c.json({ pending: true, checkout: record });
	}

	await setPendingAgentCheckout(customerId, null);
	return c.json({
		pending: false,
		captured: answer.body.status === "captured",
		credits: answer.body.credits,
	});
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
