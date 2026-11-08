/**
 * Seeds the load-test catalog + customers and writes `.customers.json`.
 *
 * Run: cd server && bun loadtest:setup (wraps this in infisical env).
 * Requires the server on localhost:8080 and UNIT_TEST_AUTUMN_SECRET_KEY.
 *
 * Idempotent — safe to re-run. Existing features/plans are detected via the
 * list endpoints and skipped; customer creation upserts.
 *
 * See README.md for the product table this seeds.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? "http://localhost:8080";
const SECRET_KEY = process.env.UNIT_TEST_AUTUMN_SECRET_KEY;
const CUSTOMER_COUNT = Number(process.env.LOAD_TEST_CUSTOMERS ?? 500);
const CUSTOMER_PREFIX = "load-cus-";
const CONCURRENCY = 10;

if (!SECRET_KEY) {
	console.error(
		"[setup] UNIT_TEST_AUTUMN_SECRET_KEY is not set — run via `bun loadtest:setup` so infisical provides it.",
	);
	process.exit(1);
}

	const headers = {
		Authorization: `Bearer ${SECRET_KEY}`,
		"Content-Type": "application/json",
	};

const request = async (
	method: string,
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; json: any }> => {
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json: any = null;
	try {
		json = await res.json();
	} catch {
		// non-JSON body (e.g. empty 204) is fine
	}
	return { ok: res.ok, status: res.status, json };
};

// ── Features ────────────────────────────────────────────────────────────────

const FEATURES = [
	{
		id: "messages",
		name: "Messages",
		type: "metered",
		consumable: true,
		display: { singular: "message", plural: "messages" },
	},
	{
		id: "dashboard",
		name: "Dashboard",
		type: "continuous_use",
		consumable: false,
		display: { singular: "dashboard", plural: "dashboards" },
	},
];

const ensureFeatures = async () => {
	const existing = await request("GET", "/v1/features");
	if (!existing.ok) {
		throw new Error(
			`GET /v1/features failed (${existing.status}): ${JSON.stringify(existing.json)}`,
		);
	}
	const existingIds = new Set(
		(existing.json?.list ?? existing.json ?? []).map((f: any) => f.id),
	);

	for (const feature of FEATURES) {
		if (existingIds.has(feature.id)) {
			console.log(`[setup] feature ${feature.id} exists, skipping`);
			continue;
		}
		const res = await request("POST", "/v1/features", feature);
		if (!res.ok && res.status !== 409) {
			throw new Error(
				`POST /v1/features ${feature.id} failed (${res.status}): ${JSON.stringify(res.json)}`,
			);
		}
		console.log(`[setup] created feature ${feature.id}`);
	}
};

// ── Plans ───────────────────────────────────────────────────────────────────

const PLANS = [
	{
		id: "load-free",
		name: "Load Free",
		group: "load-test",
		auto_enable: false,
		items: [
			{ feature_id: "dashboard" },
			{
				feature_id: "messages",
				included: 100,
				reset: { interval: "month" },
			},
		],
	},
	{
		id: "load-pro",
		name: "Load Pro",
		group: "load-test",
		price: { amount: 20, interval: "month" },
		items: [
			{ feature_id: "dashboard" },
			{
				feature_id: "messages",
				included: 1000,
				reset: { interval: "month" },
			},
		],
	},
	{
		id: "load-premium",
		name: "Load Premium",
		group: "load-test",
		price: { amount: 50, interval: "month" },
		items: [
			{ feature_id: "dashboard" },
			{ feature_id: "messages", unlimited: true },
		],
	},
	{
		id: "load-messages",
		name: "Load Messages Top-Up",
		group: "",
		add_on: true,
		items: [
			{
				feature_id: "messages",
				included: 500,
				reset: { interval: "one_off" },
				price: {
					amount: 10,
					interval: "one_off",
					// One-off prepaid top-ups don't get the default billing method.
					billing_method: "prepaid",
				},
			},
		],
	},
];

const ensurePlans = async () => {
	const existing = await request("GET", "/v1/products");
	if (!existing.ok) {
		throw new Error(
			`GET /v1/products failed (${existing.status}): ${JSON.stringify(existing.json)}`,
		);
	}
	const existingIds = new Set(
		(existing.json?.list ?? existing.json ?? []).map((p: any) => p.id),
	);

	for (const plan of PLANS) {
		if (existingIds.has(plan.id)) {
			console.log(`[setup] plan ${plan.id} exists, skipping`);
			continue;
		}
		const res = await request("POST", "/v1/products", plan);
		if (!res.ok && res.status !== 409) {
			throw new Error(
				`POST /v1/products ${plan.id} failed (${res.status}): ${JSON.stringify(res.json)}`,
			);
		}
		console.log(`[setup] created plan ${plan.id}`);
	}
};

// ── Customers ───────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(3, "0");

const seedCustomers = async () => {
	const customerIds: string[] = [];
	for (let i = 1; i <= CUSTOMER_COUNT; i++) customerIds.push(`${CUSTOMER_PREFIX}${pad(i)}`);

	let created = 0;
	let skipped = 0;

	// Small pool of workers so 500 creations don't serialize on one connection
	// while staying well under the general rate limits.
	let cursor = 0;
	const worker = async () => {
		while (cursor < customerIds.length) {
			const customerId = customerIds[cursor++];
			// POST /v1/customers parses with the fixed V0 body schema, which
			// keys the customer on `id` (not `customer_id`).
			const res = await request("POST", "/v1/customers", {
				id: customerId,
				name: `Load Test ${customerId}`,
			});
			if (res.ok) created++;
			else skipped++;
		}
	};

	await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
	console.log(
		`[setup] customers: ${created} ok, ${skipped} failed (already-existing upserts count as ok)`,
	);

	return customerIds;
};

// ── Main ────────────────────────────────────────────────────────────────────

const main = async () => {
	console.log(`[setup] target ${BASE_URL}`);

	// Artillery's --output does not create parent directories.
	mkdirSync(join(__dirname, "results"), { recursive: true });

	await ensureFeatures();
	await ensurePlans();
	const customerIds = await seedCustomers();

	// processorId mapping — synthetic, stable per customer. The attach
	// scenario doesn't send it today; the mapping preserves the contract
	// processor.mjs expects (.customers.json: customerId -> processorId).
	const customerMap: Record<string, string> = {};
	for (const customerId of customerIds) {
		customerMap[customerId] = `load-proc-${customerId.replace(CUSTOMER_PREFIX, "")}`;
	}

	writeFileSync(
		join(__dirname, ".customers.json"),
		`${JSON.stringify(customerMap, null, 2)}\n`,
	);
	console.log(
		`[setup] wrote .customers.json (${Object.keys(customerMap).length} customers)`,
	);
};

main().catch((error) => {
	console.error("[setup] failed:", error);
	process.exit(1);
});
