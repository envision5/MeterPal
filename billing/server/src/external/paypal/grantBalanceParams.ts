// billing/server/src/external/paypal/grantBalanceParams.ts
//
// Pure decision for HOW a wallet grant is applied to the balance.  Kept out
// of runPaypalWebhookHandlers.ts (which needs a live DB/Redis context) so the
// overdraft rule can be unit-tested without booting the billing stack.

import type { UpdateBalanceParamsV0 } from "@autumn/shared";

/**
 * A paid one-off credit pack must yield `amountUsd` SPENDABLE credits.
 *
 * The customer balance API clamps a negative entitlement balance to zero
 * (`cusEntsToCurrentBalance` -> `Math.max(0, cusEnt.balance)`), while the
 * admission check reads the raw negative value.  A plain `add_to_balance`
 * on an overdrawn wallet therefore leaves the buyer looking at "0.00
 * credits" after paying AND still hitting a 402 — the grant is real but
 * neither visible nor usable.  When the wallet is underwater we land the
 * balance AT the pack size instead of merely shrinking the debt by it.
 *
 * Everything else (subscription cycles, refunds, plan grants, and a paid
 * pack on a healthy wallet) keeps the plain additive behaviour.
 */
export function grantBalanceParams({
	customerId,
	featureId,
	amountUsd,
	currentBalance,
	settleOverdraft,
}: {
	customerId: string;
	featureId: string;
	amountUsd: number;
	/** Raw spendable balance, i.e. what the admission check sees. */
	currentBalance: number | null;
	settleOverdraft: boolean;
}): UpdateBalanceParamsV0 {
	if (
		settleOverdraft &&
		amountUsd > 0 &&
		currentBalance !== null &&
		currentBalance < 0
	) {
		return {
			customer_id: customerId,
			feature_id: featureId,
			remaining: amountUsd,
		};
	}

	return {
		customer_id: customerId,
		feature_id: featureId,
		add_to_balance: amountUsd,
	};
}
