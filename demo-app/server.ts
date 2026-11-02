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
import { autumnHandler } from "autumn-js/hono";
import { createMeterPal, InsufficientBalanceError } from "@meterpal/sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const DEFAULT_CUSTOMER = process.env.DEMO_CUSTOMER_ID ?? "demo-customer";

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

const app = new Hono();

// ---- local usage read (demo) ----
// The billing server's events API aggregates through Tinybird (its cloud
// analytics backend), which isn't part of the local stack.  For the demo the
// usage panel reads the Postgres events ledger directly — the same rows the
// merchant dashboard and ledger queries see.  Registered BEFORE the
// autumn-js adapter so it wins routing for this one path.
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

app.post("/api/autumn/listEvents", async (c) => {
	const body = await c.req.json().catch(() => ({}) as any);
	const customerId = c.req.header("x-meterpal-customer") ?? DEFAULT_CUSTOMER;
	const limit = Math.min(Number(body?.limit) || 50, 200);
	const startMs = Number(body?.custom_range?.start) || 0;
	const feature = process.env.METERPAL_FEATURE_ID ?? "ai_tokens";
	const sql = getBillingSql();

	const rows = startMs
		? await sql`
				select id, customer_id, event_name, value, properties, "timestamp"
				from events
				where env = 'sandbox'
					and event_name = ${feature}
					and customer_id = ${customerId}
					and "timestamp" >= ${new Date(startMs).toISOString()}
				order by "timestamp" desc
				limit ${limit}
			`
		: await sql`
				select id, customer_id, event_name, value, properties, "timestamp"
				from events
				where env = 'sandbox'
					and event_name = ${feature}
					and customer_id = ${customerId}
				order by "timestamp" desc
				limit ${limit}
			`;

	// ListEventsResponse shape the @meterpal/sdk panel expects.
	return c.json({
		list: rows.map((r: any) => ({
			id: r.id,
			timestamp: new Date(r.timestamp).getTime(),
			featureId: r.event_name,
			customerId: r.customer_id,
			value: Number(r.value ?? 0),
			properties: {
				model_id: r.properties?.model_id ?? r.properties?.model,
				input_tokens: r.properties?.input_tokens ?? 0,
				output_tokens: r.properties?.output_tokens ?? 0,
				status: r.properties?.status,
				cost_usd: r.properties?.cost ?? r.properties?.cost_usd,
			},
		})),
		nextCursor: null,
	});
});

// ---- billing routes (secret key injected here, server-side) ----
app.all(
	"/api/autumn/*",
	autumnHandler({
		identify: (c) => ({
			customerId: c.req.header("x-meterpal-customer") ?? DEFAULT_CUSTOMER,
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
	const customerId = c.req.header("x-meterpal-customer") ?? DEFAULT_CUSTOMER;
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

	const customerId = c.req.header("x-meterpal-customer") ?? DEFAULT_CUSTOMER;

	try {
		const completion = await meterpal.chat.completions.create({
			// A model id from the merchant's served catalog.
			model: model ?? process.env.DEMO_MODEL_ID ?? "custom/demo-gpt",
			messages: [{ role: "user", content: prompt }],
			// The end user being billed.
			user: customerId,
		});
		return c.json(completion);
	} catch (error) {
		// The paywall: the end user must buy credits before the model runs.
		if (error instanceof InsufficientBalanceError) {
			return c.json(
				{
					error: "insufficient_balance",
					message: error.message,
					customer_id: error.customerId,
					balance: error.balance,
					requiredCredits: error.requiredCredits,
				},
				402,
			);
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

// ---- static frontend ----
const dist = join(ROOT, "dist");
app.use("/*", serveStatic({ root: "dist", rewriteRequestPath: (p) => p }));
app.get("*", serveStatic({ path: join(dist, "index.html") }));

const port = Number(process.env.PORT ?? 5173);
console.log(`meterpal demo-app: http://localhost:${port} (customer=${DEFAULT_CUSTOMER})`);
Bun.serve({ port, fetch: app.fetch });
