import {
	type CatalogUpdateParams,
	checkScopes,
	ErrCode,
	RecaseError,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";

/**
 * The catalog routes carry plan and feature scopes; rewards are only demanded
 * of a payload that speaks for them, so an existing plans-only key keeps
 * working. Keys with no scopes at all fail open, as everywhere else.
 */
export const assertCatalogConfigResourceScope = ({
	ctx,
	params,
	scope,
}: {
	ctx: AutumnContext;
	params: CatalogUpdateParams;
	scope: "rewards:read" | "rewards:write";
}) => {
	if (
		(params.rewards === undefined && params.referral_programs === undefined) ||
		!ctx.scopes.length
	)
		return;
	const { allowed, missing } = checkScopes([scope], ctx.scopes);
	if (allowed) return;
	throw new RecaseError({
		message: `Insufficient scopes. Missing: ${missing.join(", ")}`,
		code: ErrCode.InsufficientScopes,
		statusCode: 403,
	});
};
