/**
 * Customer-safe client factory for MeterPal billing.
 *
 * The client talks to routes mounted in the HOST APP's backend via the
 * `autumn-js/backend` adapters (express / hono / next / fetch).  The backend
 * injects the secret key — no API key ever ships to the browser:
 *
 *   // your app's server (e.g. Next.js route handler / express):
 *   import { autumnBackend } from "autumn-js/backend";
 *   app.use("/api/autumn", autumnBackend({ secretKey: process.env.METERPAL_SECRET_KEY! }));
 *
 *   // your app's client:
 *   import { createMeterPalClient } from "@meterpal/sdk";
 *   const billing = createMeterPalClient({ backendUrl: "" }); // same-origin
 *   const customer = await billing.getOrCreateCustomer({ customer_id: "cus_123" });
 */
import { createAutumnClient, type IAutumnClient } from "autumn-js/react";

export interface MeterPalClientConfig {
	/** Base URL of the backend that mounts the autumn-js/backend routes. Same-origin = "". */
	backendUrl: string;
	/** Route prefix the backend mounted the billing routes under. Default "/api/autumn". */
	pathPrefix?: string;
	includeCredentials?: boolean;
	headers?: Record<string, string>;
}

export type MeterPalClient = IAutumnClient;

export function createMeterPalClient(cfg: MeterPalClientConfig): MeterPalClient {
	return createAutumnClient({
		backendUrl: cfg.backendUrl,
		pathPrefix: cfg.pathPrefix ?? "/api/autumn",
		includeCredentials: cfg.includeCredentials,
		headers: cfg.headers,
	});
}

/** @deprecated use {@link createMeterPalClient} */
export const createBillingClient = createMeterPalClient;
export type { MeterPalClientConfig as BillingClientConfig };
