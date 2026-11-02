import type {
	EntityBalance,
	FullCustomerEntitlement,
	UsageAttribution,
} from "@autumn/shared";
import { Decimal } from "decimal.js";
import { notNullish } from "@/utils/genUtils.js";

export type ResetBalancesUpdate = (
	| { entities: Record<string, EntityBalance> }
	| { balance: number; additional_balance: number; adjustment: number }
) & { usage_attribution: UsageAttribution };

/** Returns the overage amount to deduct: max(0, -balance). */
const computeOverageDeduction = ({ balance }: { balance: number }): Decimal => {
	return Decimal.max(0, new Decimal(balance).neg());
};

export const getResetBalancesUpdate = ({
	cusEnt,
	allowance,
	persistFreeOverage = false,
}: {
	cusEnt: FullCustomerEntitlement;
	allowance?: number;
	persistFreeOverage?: boolean;
}): ResetBalancesUpdate => {
	const newBalance = notNullish(allowance)
		? allowance!
		: cusEnt.entitlement.allowance || 0;

	const entitlement = cusEnt.entitlement;

	if (notNullish(entitlement.entity_feature_id)) {
		const newEntities = { ...cusEnt.entities };
		for (const entityId in newEntities) {
			const entity = newEntities[entityId];
			let entityResetBalance = newBalance;

			if (persistFreeOverage) {
				const overage = computeOverageDeduction({
					balance: entity.balance,
				});
				entityResetBalance = new Decimal(newBalance).sub(overage).toNumber();
			}

			// MeterPal wallet: purchased credit (PayPal top-ups) rides in the
			// same balance column as the allowance. Anything above the fresh
			// allowance was paid for — carry it across the reset instead of
			// wiping it.
			const entityCarryOver = Decimal.max(
				0,
				new Decimal(entity.balance ?? 0).sub(entityResetBalance),
			);
			entityResetBalance = new Decimal(entityResetBalance)
				.plus(entityCarryOver)
				.toNumber();

			newEntities[entityId].balance = entityResetBalance;
			newEntities[entityId].adjustment = 0;
		}
		return { entities: newEntities, usage_attribution: {} };
	}

	let resetBalance = newBalance;
	if (persistFreeOverage) {
		const overage = computeOverageDeduction({
			balance: cusEnt.balance ?? 0,
		});
		resetBalance = new Decimal(newBalance).sub(overage).toNumber();
	}

	// MeterPal wallet: preserve purchased credit above the fresh allowance
	// across resets (same rule as the entity branch above).
	const carryOver = Decimal.max(
		0,
		new Decimal(cusEnt.balance ?? 0).sub(resetBalance),
	);
	resetBalance = new Decimal(resetBalance).plus(carryOver).toNumber();

	return {
		balance: resetBalance,
		additional_balance: 0,
		adjustment: 0,
		usage_attribution: {},
	};
};
