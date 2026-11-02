// scripts/express-payment-test/expressApp.ts
//
// The "express payments" integration surface: an Express backend mounting
// autumn-js's Express adapter (autumnHandler) exactly the way an app
// developer would, plus the same PayPal capture/poll proxies the demo-app
// exposes.  Pointed at the TEST billing instance (:8081) so the regression
// scenario runs against the mock PayPal without touching real money.
//
// Run:  bun scripts/express-payment-test/expressApp.ts   (listens on :9080)

import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { autumnHandler } from "autumn-js/express";

const ROOT = join(import.meta.dir, "..", "..");
const TEST_BILLING_URL = process.env.TEST_BILLING_URL ?? "http://localhost:8081";

function readEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
	}
	return out;
}

const gatewayEnv = readEnvFile(join(ROOT, "gateway", ".env"));
const SECRET_KEY =
	process.env.METERPAL_SECRET_KEY ??
	gatewayEnv.PAB_API_KEY ??
	gatewayEnv.AUTUMN_API_KEY ??
	"";

if (!SECRET_KEY) {
	console.error("expressApp: no billing secret key found (METERPAL_SECRET_KEY / gateway/.env PAB_API_KEY)");
	process.exit(1);
}

const app = express();
app.use(express.json());

// ---- billing routes through the autumn-js Express adapter ----
app.use(
	"/api/autumn",
	autumnHandler({
		identify: (req) => ({
			customerId:
				(req.headers["x-meterpal-customer"] as string) ?? "express-fixtest",
		}),
		secretKey: SECRET_KEY,
		autumnURL: TEST_BILLING_URL,
	}),
);

// ---- paypal capture/poll proxies (same shape as demo-app/server.ts) ----
app.post("/api/paypal/capture/:orderId", async (req, res) => {
	const r = await fetch(
		`${TEST_BILLING_URL}/paypal/capture/${encodeURIComponent(req.params.orderId)}`,
		{ method: "POST" },
	);
	res.status(r.status).json(await r.json());
});

app.get("/api/paypal/poll", async (req, res) => {
	const customerId =
		(req.headers["x-meterpal-customer"] as string) ?? "express-fixtest";
	const r = await fetch(
		`${TEST_BILLING_URL}/paypal/poll?customer_id=${encodeURIComponent(customerId)}`,
	);
	res.status(r.status).json(await r.json());
});

const port = Number(process.env.EXPRESS_TEST_PORT ?? 9080);
app.listen(port, () => {
	console.log(`[expressApp] express payments test app on :${port} -> billing ${TEST_BILLING_URL}`);
});
