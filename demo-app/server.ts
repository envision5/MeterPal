// demo-app/server.ts
//
// One process serving the demo app:
//   /api/autumn/*  — autumn-js backend routes (injects the billing secret
//                    key server-side; the browser never sees it)
//   /api/chat      — proxy to the metered LiteLLM gateway (attaches the
//                    customer id the gateway's admission hook reads)
//   /*             — the built frontend (vite build -> dist/)
//
// Run:  bun install && bun run dev   (builds, then serves on :5173)
// Env:  METERPAL_SECRET_KEY / LITELLM_MASTER_KEY / LITELLM_URL — falls back to
//       parsing gateway/.env (demo convenience).

import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { autumnHandler } from "autumn-js/hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const GATEWAY_URL = process.env.LITELLM_URL ?? "http://localhost:4000";
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
const MASTER_KEY =
	process.env.LITELLM_MASTER_KEY ?? gatewayEnv.LITELLM_MASTER_KEY ?? "";

if (!SECRET_KEY) {
	console.error(
		"demo-app: no billing secret key — set METERPAL_SECRET_KEY or run demo/bootstrap.py to fill gateway/.env",
	);
}

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

// ---- metered chat proxy ----
app.post("/api/chat", async (c) => {
	const { prompt } = await c.req.json<{ prompt?: string }>();
	if (!prompt) return c.json({ error: "prompt required" }, 400);

	const customerId =
		c.req.header("x-meterpal-customer") ?? DEFAULT_CUSTOMER;

	const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${MASTER_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "demo-gpt",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 300,
			user: customerId,
		}),
	});

	// Surface the gateway's admission decision verbatim: 402 means the
	// pre-call /check refused the call before any provider spend.
	if (res.status !== 200) {
		const text = await res.text();
		return c.text(text || res.statusText, res.status as 402 | 500);
	}
	return c.json(await res.json());
});

// ---- static frontend ----
const dist = join(ROOT, "dist");
app.use("/*", serveStatic({ root: "dist", rewriteRequestPath: (p) => p }));
app.get("*", serveStatic({ path: join(dist, "index.html") }));

const port = Number(process.env.PORT ?? 5173);
console.log(`meterpal demo-app: http://localhost:${port} (customer=${DEFAULT_CUSTOMER})`);
Bun.serve({ port, fetch: app.fetch });
