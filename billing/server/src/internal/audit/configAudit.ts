// billing/server/src/internal/audit/configAudit.ts
//
// The SOC2 change-management trail for merchant-facing configuration
// (spec §5): PayPal connect/disconnect, served-model edits, price changes,
// plan creation.  One row per config change, with the acting user resolved
// from the auth layer.  Audit writes must never fail the request that they
// record -- a broken audit insert is logged, not thrown.

import { AuthType, configAuditLog } from "@autumn/shared";
import { logger } from "@/external/logtail/logtailUtils.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";

export const recordConfigAudit = async ({
	ctx,
	action,
	resource,
	metadata,
}: {
	ctx: AutumnContext;
	/** Dot-namespaced, e.g. "paypal.connect", "served_model.upsert". */
	action: string;
	/** The thing that changed: a product id, a model id, "org". */
	resource: string;
	metadata?: Record<string, unknown>;
}): Promise<void> => {
	const actor =
		ctx.authType === AuthType.Dashboard && ctx.userId
			? ctx.userId
			: ctx.authType === AuthType.SecretKey
				? "secret_key"
				: "system";

	try {
		await ctx.db.insert(configAuditLog).values({
			org_id: ctx.org.id,
			env: ctx.env,
			actor,
			action,
			resource,
			metadata: metadata ?? null,
		});
	} catch (e) {
		logger.error({
			msg: "config_audit_log insert failed",
			org_id: ctx.org.id,
			action,
			resource,
			err: String(e),
		});
	}
};
