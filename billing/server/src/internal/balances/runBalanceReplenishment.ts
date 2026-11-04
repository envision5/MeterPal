import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { AutoTopUpPayload } from "@/queue/workflows.js";
import { autoTopup } from "./autoTopUp/autoTopup.js";

/**
 * Replenishes a balance: charges the customer's PayPal billing agreement for
 * the top-up they configured (autoTopup.ts).
 */
export const runBalanceReplenishment = async ({
	ctx,
	payload,
}: {
	ctx: AutumnContext;
	payload: AutoTopUpPayload;
}) => {
	await autoTopup({ ctx, payload });
};
