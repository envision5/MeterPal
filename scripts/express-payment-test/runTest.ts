// scripts/express-payment-test/runTest.ts
//
// Regression test for the "one payment, many processed" bug, driven through
// the Express payments path (autumn-js express adapter + PayPal capture/poll
// proxies) against a test billing instance backed by the mock PayPal.
//
// Scenario (reproduces the exact production failure mode):
//   1. buyer clicks pack          -> order A minted (CREATED)
//   2. buyer approves A, capture MISSES (sandbox overlay loop)  -> A APPROVED, uncharged, uncredited
//   3. buyer clicks pack again    -> order B minted
//        BUG was: sweep/poll captured A too — a second charge for one payment
//        FIX:    A is abandoned, never captured
//   4. buyer approves B; onApprove capture AND poll safety-net fire together
//        -> exactly ONE capture, ONE +10 credit grant (ledger idempotency)
//   5. capture fires a third time (webhook-equivalent retry) -> still one grant
//
// Run:  bun scripts/express-payment-test/runTest.ts

const EXPRESS = process.env.EXPRESS_TEST_URL ?? "http://localhost:9080";
const TEST_BILLING_URL = process.env.TEST_BILLING_URL ?? "http://localhost:8081";
// Unique per run: the billing server caches customer lookups in redis, so a
// re-created same-id customer can briefly 404 on attach.
const CUSTOMER = `express-fixtest-${Date.now().toString(36)}`;
const PACK = "topup_10";

// ---------- tiny assertion helpers ----------
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		passed++;
		console.log(`  ✅ ${name}`);
	} else {
		failures.push(name);
		console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
	}
}
function section(name: string) {
	console.log(`\n— ${name}`);
}

// ---------- DB access (wallet_ledger + paypal_order_intents assertions) ----------
import { readFileSync } from "node:fs";
import { join } from "node:path";
function readEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
	}
	return out;
}
const env = readEnvFile(join(import.meta.dir, "..", "..", "billing", "server", ".env"));
const DATABASE_URL = env.DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
	console.error("runTest: DATABASE_URL not found in billing/server/.env");
	process.exit(1);
}
const db = new Bun.SQL(DATABASE_URL);

async function ledgerRows(): Promise<{ id: number; amount_usd: number; credits_delta: number; idempotency_key: string; via: string }[]> {
	const rows = await db`
		select id, amount_usd, credits_delta, idempotency_key,
			coalesce(metadata->>'via','') as via
		from wallet_ledger
		where customer_id = ${CUSTOMER}
		order by id`;
	return rows as any;
}
async function intents(): Promise<{ order_id: string; status: string; id: number }[]> {
	const rows = await db`
		select id, order_id, status from paypal_order_intents
		where customer_id = ${CUSTOMER} order by id`;
	return rows as any;
}
async function mockOrders(): Promise<Record<string, { id: string; status: string; captures: unknown[] }>> {
	const r = await fetch("http://localhost:9099/__test/orders");
	return (await r.json()).orders;
}

// ---------- express payments path helpers ----------
async function autumn<T = any>(route: string, body: unknown): Promise<T> {
	const r = await fetch(`${EXPRESS}/api/autumn/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-meterpal-customer": CUSTOMER },
		body: JSON.stringify(body),
	});
	return (await r.json()) as T;
}
async function attachAndGetOrderId(): Promise<string> {
	const res: any = await autumn("attach", { planId: PACK });
	const checkoutUrl = res?.payment_url ?? res?.paymentUrl ?? res?.checkout_url ?? res?.url;
	if (!checkoutUrl) throw new Error(`attach returned no checkout url: ${JSON.stringify(res).slice(0, 300)}`);
	const orderId = new URL(checkoutUrl).searchParams.get("token");
	if (!orderId) throw new Error(`no token in checkout url: ${checkoutUrl}`);
	return orderId;
}
const capture = (orderId: string) =>
	fetch(`${EXPRESS}/api/paypal/capture/${encodeURIComponent(orderId)}`, { method: "POST" }).then((r) => r.json());
const poll = () =>
	fetch(`${EXPRESS}/api/paypal/poll`, { headers: { "x-meterpal-customer": CUSTOMER } }).then((r) => r.json());
const approve = (orderId: string) =>
	fetch(`http://localhost:9099/__test/approve/${orderId}`, { method: "POST" }).then((r) => r.json());

// ---------- scenario ----------
async function main() {
	console.log("Express payments regression test — one payment = one capture = +10 credits\n");

	section("0. setup: reset mock paypal, recreate test customer");
	await fetch("http://localhost:9099/__test/reset", { method: "POST" });
	await db`delete from wallet_ledger where customer_id = ${CUSTOMER}`;
	await db`delete from paypal_order_intents where customer_id = ${CUSTOMER}`;
	await db`delete from customer_products where customer_id in (select internal_id from customers where id = ${CUSTOMER})`;
	await db`delete from customers where id = ${CUSTOMER}`;
	const created: any = await autumn("getOrCreateCustomer", { customerId: CUSTOMER, name: "Express Fixtest" });
	check("customer created via express adapter", Boolean(created?.id ?? created?.customer?.id), created);
	const before = await ledgerRows();
	check("wallet_ledger empty for test customer", before.length === 0, before);

	section("1. first purchase: attach mints order A (CREATED)");
	const orderA = await attachAndGetOrderId();
	check("order A minted", /^MOCK/.test(orderA), orderA);

	section("2. buyer approves A but the capture misses (production failure mode)");
	const ap = await approve(orderA);
	check("order A approved at paypal", ap?.status === "APPROVED", ap);

	section("3. buyer clicks pack again: order B minted — the sweep must NOT charge A");
	const orderB = await attachAndGetOrderId();
	check("order B minted", /^MOCK/.test(orderB) && orderB !== orderA, orderB);
	await new Promise((r) => setTimeout(r, 300));
	const rowsAfterReattach = await ledgerRows();
	check(
		"stale approved order A was NOT captured (no new ledger row)",
		rowsAfterReattach.length === 0,
		rowsAfterReattach,
	);
	const mockA = (await mockOrders())[orderA];
	check("order A still uncharged at paypal (0 captures)", mockA?.captures?.length === 0, mockA);
	const intentRows = await intents();
	const intentA = intentRows.find((i) => i.order_id === orderA);
	check("intent A marked abandoned", intentA?.status === "abandoned", intentRows);

	section("4. buyer approves B; onApprove capture and poll safety-net fire together");
	await approve(orderB);
	const [captureRes, pollRes] = await Promise.all([capture(orderB), poll()]);
	check("onApprove capture succeeded", captureRes?.status === "captured" && captureRes?.credits === 10, captureRes);
	check(
		"poll saw the payment (captured or already finalized)",
		pollRes?.status === "captured" || pollRes?.status === "none",
		pollRes,
	);
	await new Promise((r) => setTimeout(r, 300));
	const rowsAfterCapture = await ledgerRows();
	check("exactly ONE wallet grant", rowsAfterCapture.length === 1, rowsAfterCapture);
	check("grant is +10 credits", rowsAfterCapture[0]?.credits_delta === 10, rowsAfterCapture[0]);

	section("5. a third capture path fires (webhook-equivalent retry) — still one grant");
	const again = await capture(orderB);
	check("retry capture is idempotent", again?.status === "captured" || again?.status === "unapproved:COMPLETED", again);
	await new Promise((r) => setTimeout(r, 300));
	const rowsAfterRetry = await ledgerRows();
	check("still exactly ONE wallet grant after retry", rowsAfterRetry.length === 1, rowsAfterRetry);

	section("6. poll with no live checkout is a no-op");
	const pollNone = await poll();
	check("poll returns none (B's intent already finalized)", pollNone?.status === "none", pollNone);
	const rowsFinal = await ledgerRows();
	check("ledger unchanged by idle poll", rowsFinal.length === 1, rowsFinal);

	section("7. customer balance through the express adapter");
	const cust: any = await autumn("getOrCreateCustomer", { customerId: CUSTOMER });
	const balances = cust?.balances ?? cust?.customer?.balances ?? {};
	const featureId = env.METERPAL_CREDIT_FEATURE_ID ?? "ai_tokens";
	const creditBalances = Object.values<any>(balances).filter((b) => b?.feature_id === featureId || b?.featureId === featureId);
	const totalCredits = creditBalances.reduce((s, b) => s + Number(b.balance ?? b?.remaining ?? 0), 0);
	check("customer wallet shows the granted credits", totalCredits >= 10, { featureId, balances: Object.keys(balances) });

	// ---------- standard paypal payment flow (full redirect) ----------
	async function customerRow(): Promise<any> {
		const rows = await db`select paypal_subscription_id, paypal_plan_id, paypal_payment_status from customers where id = ${CUSTOMER}`;
		return rows[0];
	}
	const redirect = async (path: string) =>
		fetch(`${TEST_BILLING_URL}/paypal/return${path}`, { redirect: "manual" });

	section("8. standard flow — plan subscription: no duplicate subscriptions");
	const subAttach = async () => {
		const res: any = await autumn("attach", { planId: "pro" });
		return res?.payment_url ?? res?.paymentUrl ?? res?.checkout_url ?? res?.url;
	};
	const subUrl1 = await subAttach();
	const subId1 = subUrl1 ? new URL(subUrl1).searchParams.get("token") : null;
	check("subscription minted (I- token in approval url)", /^I-/.test(subId1 ?? ""), subUrl1);
	const subUrl2 = await subAttach();
	const subId2 = subUrl2 ? new URL(subUrl2).searchParams.get("token") : null;
	check("second plan click REUSES the same subscription (no duplicate charge possible)", subId2 === subId1, { subId1, subId2 });
	const subCount1 = Object.keys((await (await fetch("http://localhost:9099/__test/subscriptions")).json()).subscriptions).length;
	check("exactly ONE paypal subscription exists", subCount1 === 1, subCount1);
	check("customer stamped pending", (await customerRow())?.paypal_payment_status === "pending", await customerRow());

	section("9. standard flow — buyer approves the subscription; return route activates");
	await fetch(`http://localhost:9099/__test/approveSub/${subId1}`, { method: "POST" });
	const ret = await redirect(`?token=${subId1}`);
	check("browser return redirects to the app with success", ret.status === 302 && (ret.headers.get("location") ?? "").includes("payment=success"), { status: ret.status, location: ret.headers.get("location") });
	check("subscription activated on return", (await customerRow())?.paypal_payment_status === "active", await customerRow());
	const ret2 = await redirect(`?token=${subId1}`);
	check("return replay is idempotent (still success)", ret2.status === 302 && (ret2.headers.get("location") ?? "").includes("payment=success"), ret2.headers.get("location"));

	section("10. standard flow — plan click after activation never re-charges");
	const subUrl3 = await subAttach();
	check("attach on an active subscription lands on success without minting", (subUrl3 ?? "").includes("payment=success"), subUrl3);
	const subCount2 = Object.keys((await (await fetch("http://localhost:9099/__test/subscriptions")).json()).subscriptions).length;
	check("still exactly ONE paypal subscription", subCount2 === 1, subCount2);

	section("11. standard flow — credit pack via full redirect (browser return)");
	const ledgerBeforeRedirect = (await ledgerRows()).length;
	const orderC = await attachAndGetOrderId();
	await approve(orderC);
	const retOrder = await redirect(`?token=${orderC}`);
	const loc = retOrder.headers.get("location") ?? "";
	check("order return captured and redirects with credits", retOrder.status === 302 && loc.includes("payment=success") && loc.includes("credits=10"), loc);
	const ledgerAfterRedirect = await ledgerRows();
	check("exactly one new grant from the redirect flow", ledgerAfterRedirect.length === ledgerBeforeRedirect + 1, ledgerAfterRedirect.length);
	const retOrderReplay = await redirect(`?token=${orderC}`);
	check("order return replay does not double-grant", retOrderReplay.status === 302 && (retOrderReplay.headers.get("location") ?? "").includes("payment=success"), retOrderReplay.headers.get("location"));
	check("still exactly one new grant after replay", (await ledgerRows()).length === ledgerBeforeRedirect + 1, (await ledgerRows()).length);

	section("12. return route edges (cancelled / missing token)");
	const retCancel = await redirect("?cancelled=1");
	check("cancelled return lands on payment=cancelled", (retCancel.headers.get("location") ?? "").includes("payment=cancelled"), retCancel.headers.get("location"));
	const retNoToken = await redirect("");
	check("missing token lands on payment=error", (retNoToken.headers.get("location") ?? "").includes("payment=error"), retNoToken.headers.get("location"));

	// cleanup: drop the test customer so re-runs start fresh
	await db`delete from customer_products where customer_id in (select internal_id from customers where id = ${CUSTOMER})`;
	await db`delete from customers where id = ${CUSTOMER}`;

	console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failures.length} failed`);
	if (failures.length > 0) {
		console.log("failed:", failures.join(", "));
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error("runTest crashed:", e);
	process.exit(1);
});
