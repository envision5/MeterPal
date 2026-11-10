// billing/server/src/internal/balances/trackWebhooks/handleBalanceDepleted.ts
//
// "The customer's wallet just ran dry" — detected at the exact moment it
// happens, inside the deduction, where both the old and the new balance are
// known.
//
// Why this exists: an agent that manages a customer's wallet (the demo's
// buyer agent) should be able to top the wallet up the moment the credits
// run out, not the next time the customer happens to send a message and
// gets a 402.  Waiting for the 402 makes the agent reactive instead of
// proactive, and it means a customer who has stopped using the product
// never gets topped up at all.
//
// The signal is a marker on the customer (`metadata.balance_depleted`)
// because that is where the rest of the agent contract already lives: the
// mandate, and the checkout the agent has open.  It is durable, so an
// agent host that was down when the credits ran out still finds out.
//
// Deliberately scoped to customers who gave an agent a mandate: for
// everyone else a drained wallet is just a drained wallet, and writing a
// marker for them would be noise on the hottest path in the server.

import {
	customers,
	cusEntsToBalance,
	fullCustomerToCustomerEntitlements,
	type Feature,
	type FullCustomer,
} from "@autumn/shared";
import { and, eq, sql } from "drizzle-orm";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { readMandate } from "@/internal/agents/buyerMandate.js";

/** The balance of one feature for a customer, across all their entitlements. */
export const featureBalance = ({
	fullCus,
	featureId,
}: {
	fullCus: FullCustomer;
	featureId: string;
}): number => {
	const cusEnts = fullCustomerToCustomerEntitlements({
		fullCustomer: fullCus,
		featureId,
	});
	if (cusEnts.length === 0) return 0;
	return Number(cusEntsToBalance({ cusEnts, withRollovers: true }));
};

/**
 * True when this deduction took the customer's balance from positive to
 * empty — the transition, not the state.  A wallet that was already empty
 * and stays empty is not a new depletion.
 */
export const isDepletion = ({
	oldBalance,
	newBalance,
}: {
	oldBalance: number;
	newBalance: number;
}): boolean => oldBalance > 0 && newBalance <= 0;

export type BalanceDepletedMarker = {
	feature_id: string;
	/** Epoch ms of the depletion. */
	at: number;
	/** The balance when the credits ran out. */
	balance: number;
	/** The balance the deduction came out of. */
	previous_balance: number;
};

/**
 * Records the depletion on the customer.  Written as a single jsonb_set so
 * it can never clobber the mandate (or the pending checkout) that lives
 * next to it in the same metadata blob.
 */
export const stampBalanceDepleted = async ({
	ctx,
	customerId,
	marker,
}: {
	ctx: AutumnContext;
	customerId: string;
	marker: BalanceDepletedMarker;
}): Promise<void> => {
	await ctx.db
		.update(customers)
		.set({
			metadata: sql`jsonb_set(
				coalesce(${customers.metadata}, '{}'::jsonb),
				'{balance_depleted}',
				${JSON.stringify(marker)}::jsonb,
				true
			)`,
		})
		.where(
			and(
				eq(customers.id, customerId),
				eq(customers.org_id, ctx.org.id),
				eq(customers.env, ctx.env),
			),
		);
};

/**
 * The hook itself.  Call it with the customer's balance before and after a
 * deduction; it decides whether the wallet just ran dry and, if an agent is
 * standing by for this customer, records the signal.
 */
export const handleBalanceDepleted = async ({
	ctx,
	oldFullCus,
	newFullCus,
	feature,
}: {
	ctx: AutumnContext;
	oldFullCus: FullCustomer;
	newFullCus: FullCustomer;
	feature: Feature;
}): Promise<void> => {
	// Cheap check first: nobody is managing this wallet, so there is nothing
	// to wake up.  This runs on every deduction, so it must stay cheap.
	if (!readMandate(newFullCus.metadata)) return;

	const customerId = newFullCus.id;
	if (!customerId) return;

	const oldBalance = featureBalance({ fullCus: oldFullCus, featureId: feature.id });
	const newBalance = featureBalance({ fullCus: newFullCus, featureId: feature.id });
	if (!isDepletion({ oldBalance, newBalance })) return;

	const marker: BalanceDepletedMarker = {
		feature_id: feature.id,
		at: Date.now(),
		balance: newBalance,
		previous_balance: oldBalance,
	};

	try {
		await stampBalanceDepleted({ ctx, customerId, marker });
		ctx.logger.info(
			`[handleBalanceDepleted] wallet emptied: customer ${customerId}, feature ${feature.id}, ${oldBalance} -> ${newBalance}`,
		);
	} catch (error) {
		// A failed marker must never fail the charge that triggered it.
		ctx.logger.error(
			`[handleBalanceDepleted] failed to record depletion for ${customerId}: ${error}`,
		);
	}
};
