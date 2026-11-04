import type { FullCusEntWithFullCusProduct } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";

/**
 * Replaceables consumed when an entity-scoped balance moves down by
 * `usageDiff` units.
 */
export function getReps({
	cusEnt,
	prevBalance,
	newBalance,
}: {
	cusEnt: FullCusEntWithFullCusProduct;
	prevBalance: number;
	newBalance: number;
}) {
	const usageDiff = prevBalance - newBalance;
	const reps = cusEnt.replaceables.slice(0, usageDiff);
	return reps;
}

/**
 * Arrear-prorated entitlements are repriced by the processor at the cycle
 * boundary; adjusting an allowance mid-cycle no longer issues a standalone
 * invoice, so this is a no-op beyond the balance write the caller performs.
 */
export const adjustAllowance = async ({
	ctx,
	cusEnt,
}: {
	ctx: AutumnContext;
	cusEnt: FullCusEntWithFullCusProduct;
	[key: string]: unknown;
}): Promise<{
	newReplaceables: any[];
	invoice: null;
	deletedReplaceables: null;
}> => {
	ctx.logger.info(
		`[adjustAllowance] No mid-cycle invoice for entitlement ${cusEnt.id}; balance update handled by caller`,
	);
	return { newReplaceables: [], invoice: null, deletedReplaceables: null };
};
