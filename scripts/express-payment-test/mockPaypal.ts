// scripts/express-payment-test/mockPaypal.ts
//
// Minimal in-memory mock of the PayPal Orders v2 REST API, used by the
// express payment regression test (runTest.ts) to drive approvals without a
// real sandbox buyer.  Implements exactly what billing/server touches:
//   POST /v1/oauth2/token
//   POST /v2/checkout/orders            (create)
//   GET  /v2/checkout/orders/:id
//   POST /v2/checkout/orders/:id/capture (only valid from APPROVED)
//   POST /v2/checkout/orders/:id/cancel  (only valid from CREATED — mirrors
//                                         real PayPal semantics the sweep
//                                         relies on)
//   POST /v1/billing/subscriptions       (create — status CREATED)
//   GET  /v1/billing/subscriptions/:id
//   POST /v1/billing/subscriptions/:id/cancel
// plus test-control endpoints:
//   POST /__test/approve/:orderId     — simulates the buyer clicking "Pay Now"
//   POST /__test/approveSub/:subId    — simulates the buyer approving a plan
//   GET  /__test/orders | /__test/subscriptions — state dumps
//
// Run:  bun scripts/express-payment-test/mockPaypal.ts   (listens on :9099)

interface MockCapture {
	id: string;
	status: string;
	amount: { currency_code: string; value: string };
	create_time: string;
}

interface MockOrder {
	id: string;
	status: "CREATED" | "APPROVED" | "COMPLETED" | "CANCELLED";
	amount: string;
	custom_id: string;
	captures: MockCapture[];
	create_time: string;
}

interface MockSubscription {
	id: string;
	plan_id: string;
	status: "CREATED" | "APPROVED" | "ACTIVE" | "CANCELLED";
	custom_id: string;
	create_time: string;
}

const orders = new Map<string, MockOrder>();
const subscriptions = new Map<string, MockSubscription>();
// Ids are seeded from boot time so a mock restart can never re-mint ids that
// still exist in the billing DB's unique paypal_order_intents.order_id column.
let orderSeq = Date.now() - 1_767_000_000_000;
let subSeq = Date.now() - 1_767_000_000_000;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function readBody(req: Request): Promise<any> {
	try {
		return await req.json();
	} catch {
		return {};
	}
}

Bun.serve({
	port: Number(process.env.MOCK_PAYPAL_PORT ?? 9099),
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;
		const method = req.method;

		// ---- test control ----
		if (method === "POST" && path.startsWith("/__test/approve/")) {
			const id = path.split("/").pop()!;
			const order = orders.get(id);
			if (!order) return json({ error: "order_not_found" }, 404);
			if (order.status !== "CREATED") {
				return json(
					{ error: "not_cancellable_state", status: order.status },
					422,
				);
			}
			order.status = "APPROVED";
			console.log(`[mockPayPal] buyer approved order ${id}`);
			return json({ id, status: "APPROVED" });
		}

		if (method === "POST" && path.startsWith("/__test/approveSub/")) {
			const id = path.split("/").pop()!;
			const sub = subscriptions.get(id);
			if (!sub) return json({ error: "subscription_not_found" }, 404);
			if (sub.status !== "CREATED") {
				return json(
					{ error: "not_approvable_state", status: sub.status },
					422,
				);
			}
			sub.status = "APPROVED";
			console.log(`[mockPayPal] buyer approved subscription ${id}`);
			return json({ id, status: "APPROVED" });
		}

		if (method === "GET" && path === "/__test/orders") {
			return json({ orders: Object.fromEntries(orders) });
		}

		if (method === "GET" && path === "/__test/subscriptions") {
			return json({ subscriptions: Object.fromEntries(subscriptions) });
		}

		if (method === "POST" && path === "/__test/reset") {
			orders.clear();
			subscriptions.clear();
			return json({ ok: true });
		}

		// ---- OAuth ----
		if (method === "POST" && path === "/v1/oauth2/token") {
			return json({ access_token: "mock-token", expires_in: 32400 });
		}

		// ---- create order ----
		if (method === "POST" && path === "/v2/checkout/orders") {
			const body = await readBody(req);
			const pu = body.purchase_units?.[0];
			const id = `MOCK${String(++orderSeq).padStart(11, "0")}`;
			const order: MockOrder = {
				id,
				status: "CREATED",
				amount: pu?.amount?.value ?? "0.00",
				custom_id: pu?.custom_id ?? "",
				captures: [],
				create_time: new Date().toISOString(),
			};
			orders.set(id, order);
			console.log(`[mockPayPal] created order ${id} amount=${order.amount}`);
			return json({
				id,
				status: "CREATED",
				links: [
					{
						rel: "approve",
						href: `http://localhost:9099/checkoutnow?token=${id}`,
					},
					{ rel: "self", href: `http://localhost:9099/v2/checkout/orders/${id}`, method: "GET" },
				],
			});
		}

		// ---- get order ----
		const getOrder = path.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)$/);
		if (method === "GET" && getOrder) {
			const order = orders.get(getOrder[1]);
			if (!order) return json({ name: "INVALID_RESOURCE_ID" }, 404);
			return json({
				id: order.id,
				status: order.status,
				create_time: order.create_time,
				purchase_units: [
					{
						custom_id: order.custom_id,
						amount: { currency_code: "USD", value: order.amount },
						...(order.captures.length > 0
							? { payments: { captures: order.captures } }
							: {}),
					},
				],
			});
		}

		// ---- capture order ----
		const captureOrder = path.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/);
		if (method === "POST" && captureOrder) {
			const order = orders.get(captureOrder[1]);
			if (!order) return json({ name: "INVALID_RESOURCE_ID" }, 404);
			if (order.status !== "APPROVED") {
				return json(
					{
						name: "UNPROCESSABLE_ENTITY",
						details: [
							{
								issue:
									order.status === "COMPLETED"
										? "ORDER_ALREADY_CAPTURED"
										: "ORDER_NOT_APPROVED",
							},
						],
					},
					422,
				);
			}
			const capture: MockCapture = {
				id: `CAP${order.id.slice(4)}`,
				status: "COMPLETED",
				amount: { currency_code: "USD", value: order.amount },
				create_time: new Date().toISOString(),
			};
			order.captures.push(capture);
			order.status = "COMPLETED";
			console.log(`[mockPayPal] captured order ${order.id} (${order.amount} USD)`);
			return json({
				id: order.id,
				status: "COMPLETED",
				purchase_units: [
					{
						custom_id: order.custom_id,
						payments: { captures: [capture] },
					},
				],
			});
		}

		// ---- cancel order ----
		const cancelOrder = path.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/cancel$/);
		if (method === "POST" && cancelOrder) {
			const order = orders.get(cancelOrder[1]);
			if (!order) return json({ name: "INVALID_RESOURCE_ID" }, 404);
			if (order.status !== "CREATED") {
				// mirrors real PayPal: only CREATED orders are cancellable
				return json(
					{ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "NOT_CANCELABLE" }] },
					422,
				);
			}
			order.status = "CANCELLED";
			console.log(`[mockPayPal] cancelled order ${order.id}`);
			return json({ id: order.id, status: "CANCELLED" });
		}

		// ---- catalog product (ensurePaypalPlan) ----
		if (method === "POST" && path === "/v1/catalog/products") {
			const body = await readBody(req);
			return json({
				id: `P-MOCKPROD${String(++subSeq).padStart(8, "0")}`,
				name: body.name ?? "Mock Product",
				status: "ACTIVE",
			});
		}

		// ---- billing plan (ensurePaypalPlan) ----
		if (method === "POST" && path === "/v1/billing/plans") {
			const body = await readBody(req);
			return json({
				id: `P-MOCKPLAN${String(++subSeq).padStart(8, "0")}`,
				product_id: body.product_id ?? "",
				name: body.name ?? "Mock Plan",
				status: "ACTIVE",
			});
		}

		// ---- create subscription ----
		if (method === "POST" && path === "/v1/billing/subscriptions") {
			const body = await readBody(req);
			const id = `I-MOCK${String(++subSeq).padStart(10, "0")}`;
			const sub: MockSubscription = {
				id,
				plan_id: body.plan_id ?? "",
				status: "CREATED",
				custom_id: body.custom_id ?? "",
				create_time: new Date().toISOString(),
			};
			subscriptions.set(id, sub);
			console.log(
				`[mockPayPal] created subscription ${id} plan=${sub.plan_id}`,
			);
			return json({
				id,
				plan_id: sub.plan_id,
				status: sub.status,
				custom_id: sub.custom_id,
				create_time: sub.create_time,
				links: [
					{
						rel: "approve",
						href: `http://localhost:9099/billingflow?token=${id}`,
					},
				],
			});
		}

		// ---- get subscription ----
		const getSub = path.match(/^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)$/);
		if (method === "GET" && getSub) {
			const sub = subscriptions.get(getSub[1]);
			if (!sub) return json({ name: "INVALID_RESOURCE_ID" }, 404);
			return json({
				id: sub.id,
				plan_id: sub.plan_id,
				status: sub.status,
				custom_id: sub.custom_id,
				create_time: sub.create_time,
				subscriber: {},
				// real PayPal returns the full link set on GET — the approve link
				// is what subscription reuse reads back
				links: [
					{
						rel: "approve",
						href: `http://localhost:9099/billingflow?token=${sub.id}`,
					},
				],
			});
		}

		// ---- cancel subscription ----
		const cancelSub = path.match(/^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)\/cancel$/);
		if (method === "POST" && cancelSub) {
			const sub = subscriptions.get(cancelSub[1]);
			if (!sub) return json({ name: "INVALID_RESOURCE_ID" }, 404);
			if (sub.status === "CANCELLED") {
				return json({ name: "UNPROCESSABLE_ENTITY" }, 422);
			}
			sub.status = "CANCELLED";
			console.log(`[mockPayPal] cancelled subscription ${sub.id}`);
			return json({ id: sub.id, status: "CANCELLED" });
		}

		return json({ error: "not_found", path }, 404);
	},
});

console.log("[mockPayPal] listening on :" + (process.env.MOCK_PAYPAL_PORT ?? 9099));
