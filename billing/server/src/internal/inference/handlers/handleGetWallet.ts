// billing/server/src/internal/inference/handlers/handleGetWallet.ts
//
// GET /v1/wallet?customer_id=...&feature_id=...
//
// The customer's wallet, in the numbers that actually differ from each
// other:
//
//   balance   what can be spent RIGHT NOW.  Admission control gates on this.
//             It already has in-flight reservations taken out of it.
//   held      the reservations of the calls running this instant.
//   settled   what the customer has actually spent down to.  THIS is the
//             number to show a human as "credits".
//   granted   everything granted, so a progress bar has a denominator.
//
// `settled` is computed by walletProjection, which deliberately does NOT
// read `balance` for its current value.  See that module for the full
// explanation: the balance row and the hold ledger are written by two
// different async batchers, so `balance + held` has ~600ms windows where it
// spikes and dips by the whole reservation.  The projection derives the
// number from the append-only settled-charge ledger instead.

import { Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { readWallet } from "@/internal/balances/walletProjection.js";
import { litellmFeatureId } from "@/internal/keys/litellmEnv.js";

export const handleGetWallet = createRoute({
	scopes: [Scopes.Balances.Read],
	handler: async (c) => {
		const { db, org, env } = c.get("ctx");

		const customerId = c.req.query("customer_id");
		if (!customerId) {
			return c.json(
				{ message: "customer_id is required", code: "invalid_request" },
				400,
			);
		}
		const featureId = c.req.query("feature_id") ?? litellmFeatureId();

		const wallet = await readWallet({
			db,
			orgId: org.id,
			env,
			customerId,
			featureId,
		});

		return c.json({
			customer_id: customerId,
			feature_id: featureId,
			...wallet,
		});
	},
});
