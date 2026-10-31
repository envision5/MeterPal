// agent/mcp/server.ts
//
// MeterPal MCP server — lets any MCP-capable agent (Claude Desktop, OpenAI
// agent SDK, LangChain, an in-app assistant) manage the merchant's AI
// billing workflow: inspect usage and balances, top up wallets, send PayPal
// overage invoices, and mint PayPal checkout links.
//
// Tools are thin wrappers over the MeterPal billing server REST API; the
// secret key stays in this process (METERPAL_SECRET_KEY), never in the model.
//
// Compose with PayPal's own remote MCP server (https://mcp.paypal.com/sse)
// for PayPal-native operations beyond these (transaction search, disputes,
// subscription management) — MCP clients accept both servers side by side.
//
// Run:  bun mcp/server.ts        (stdio transport)
// Env:  METERPAL_BASE_URL (default http://localhost:8080/v1)
//       METERPAL_SECRET_KEY (am_sk_... — required)
//       METERPAL_FEATURE_ID (default ai_tokens)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.METERPAL_BASE_URL ?? "http://localhost:8080/v1").replace(/\/$/, "");
const SECRET_KEY = process.env.METERPAL_SECRET_KEY ?? "";
const FEATURE_ID = process.env.METERPAL_FEATURE_ID ?? "ai_tokens";

if (!SECRET_KEY) {
	console.error("meterpal-mcp: METERPAL_SECRET_KEY is required");
	process.exit(1);
}

async function api<T = unknown>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${SECRET_KEY}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`meterpal API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
	}
	return (text ? JSON.parse(text) : null) as T;
}

const server = new McpServer(
	{ name: "meterpal-billing", version: "0.1.0" },
	{ capabilities: { tools: {} } },
);

// ---- tools ----

server.tool(
	"meterpal_get_customer",
	"Fetch a MeterPal customer: wallet balance for the AI credit feature, plan, and PayPal payment status",
	{ customer_id: z.string().describe("MeterPal customer id") },
	async ({ customer_id }) => {
		const customer = await api("GET", `/customers/${encodeURIComponent(customer_id)}?expand=balances.feature`);
		const balance = (customer as any).balances?.find(
			(b: any) => (b.feature_id ?? b.feature?.id) === FEATURE_ID,
		);
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{
							customer_id: (customer as any).id,
							email: (customer as any).email,
							credits_balance: balance?.remaining ?? null,
							credits_max: balance?.max ?? null,
							paypal_payment_status: (customer as any).paypal_payment_status ?? null,
							paypal_subscription_id: (customer as any).paypal_subscription_id ?? null,
						},
						null,
						2,
					),
				},
			],
		};
	},
);

server.tool(
	"meterpal_get_customer_usage",
	"Aggregate AI usage for a customer over the last N days: credits spent, requests, per-model breakdown (from the events ledger)",
	{
		customer_id: z.string().describe("MeterPal customer id"),
		days: z.number().optional().describe("Lookback window in days (default 30)"),
	},
	async ({ customer_id, days = 30 }) => {
		const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
		const events = (await api("POST", "/events/list", {
			customer_id,
			feature_id: FEATURE_ID,
			limit: 500,
			custom_range: { start: sinceMs },
		})) as any;

		const list: any[] = events?.list ?? events?.events ?? [];
		const byModel = new Map<string, { credits: number; requests: number }>();
		let totalCredits = 0;
		for (const evt of list) {
			const model = evt.properties?.model_id ?? evt.properties?.model ?? "other";
			const credits = Number(evt.value ?? 0);
			totalCredits += credits;
			const entry = byModel.get(model) ?? { credits: 0, requests: 0 };
			entry.credits += credits;
			entry.requests += 1;
			byModel.set(model, entry);
		}
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{
							customer_id,
							window_days: days,
							credits_spent: Number(totalCredits.toFixed(4)),
							requests: list.length,
							by_model: Object.fromEntries(
								[...byModel.entries()].map(([m, v]) => [
									m,
									{ credits: Number(v.credits.toFixed(4)), requests: v.requests },
								]),
							),
						},
						null,
						2,
					),
				},
			],
		};
	},
);

server.tool(
	"meterpal_list_low_balance_customers",
	"List customers whose AI credit balance is below a threshold (default: half a credit) — the overage/top-up outreach list",
	{
		below_credits: z.number().optional().describe("Threshold (default 0.5)"),
	},
	async ({ below_credits = 0.5 }) => {
		const page = (await api("POST", "/customers/list", { limit: 100 })) as any;
		const rows = (page?.items ?? page?.customers ?? []) as any[];
		const low = rows
			.map((c) => {
				const bal = c.balances?.find(
					(b: any) => (b.feature_id ?? b.feature?.id) === FEATURE_ID,
				);
				return {
					customer_id: c.id,
					email: c.email,
					credits: bal?.remaining ?? null,
					paypal_payment_status: c.paypal_payment_status ?? null,
				};
			})
			.filter((r) => r.credits !== null && r.credits < below_credits)
			.sort((a, b) => (a.credits ?? 0) - (b.credits ?? 0));
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{ threshold_credits: below_credits, count: low.length, customers: low },
						null,
						2,
					),
				},
			],
		};
	},
);

server.tool(
	"meterpal_grant_credits",
	"Grant (or, with a negative amount, claw back) AI credits to a customer's wallet. Prefer meterpal_create_overage_invoice for paid top-ups — this is for compensations and seeding",
	{
		customer_id: z.string().describe("MeterPal customer id"),
		credits: z.number().describe("Credits to grant (1 credit = 1 USD of model cost)"),
		reason: z.string().optional().describe("Why — recorded in the audit log"),
	},
	async ({ customer_id, credits, reason }) => {
		await api("POST", "/balances/update", {
			customer_id,
			feature_id: FEATURE_ID,
			add_to_balance: credits,
		});
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{ granted: credits, customer_id, feature_id: FEATURE_ID, reason: reason ?? null },
						null,
						2,
					),
				},
			],
		};
	},
);

server.tool(
	"meterpal_create_overage_invoice",
	"Create and send a PayPal invoice for AI usage overage. When the buyer pays it, the INVOICING.INVOICE.PAID webhook credits their wallet automatically",
	{
		customer_id: z.string().describe("MeterPal customer id"),
		amount_usd: z.number().positive().describe("Overage amount in USD"),
		item_name: z.string().optional().describe("Line item label"),
		memo: z.string().optional().describe("Context shown to the payer"),
	},
	async ({ customer_id, amount_usd, item_name, memo }) => {
		const invoice = await api("POST", "/overage_invoices", {
			customer_id,
			amount_usd,
			item_name: item_name ?? "AI usage overage",
			memo,
		});
		return {
			content: [
				{ type: "text" as const, text: JSON.stringify(invoice, null, 2) },
			],
		};
	},
);

server.tool(
	"meterpal_create_checkout_link",
	"Create a PayPal checkout (Orders v2 credit pack or plan subscription) and return the buyer approval link",
	{
		customer_id: z.string().describe("MeterPal customer id"),
		product_id: z.string().describe("Product id: a credit pack (one-off) or a plan (subscription)"),
		success_url: z.string().optional().describe("Where PayPal sends the buyer after approval"),
	},
	async ({ customer_id, product_id, success_url }) => {
		const body: Record<string, unknown> = { customer_id, product_id };
		if (success_url) body.success_url = success_url;
		const res = await api<any>("POST", "/checkout", body);
		return {
			content: [
				{ type: "text" as const, text: JSON.stringify({ checkout_url: res?.url ?? null, raw: res }, null, 2) },
			],
		};
	},
);

// ---- serve ----

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`meterpal-mcp: serving tools over stdio (${BASE_URL}, feature=${FEATURE_ID})`);
