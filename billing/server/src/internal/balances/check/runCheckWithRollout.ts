import type { ParsedCheckParams } from "@autumn/shared";
import { withRedisFailOpen } from "@/external/redis/utils/withRedisFailOpen.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { CheckData } from "@/internal/api/check/checkTypes/CheckData.js";
import { getCheckFailOpenFallback } from "@/internal/api/check/checkUtils/getCheckFailOpenFallback.js";
import { dependencyUnavailableError, isDepFailClosed } from "@/internal/misc/dependencyPolicy/dependencyPolicy.js";
import { isFullSubjectGateRejection } from "@/internal/customers/repos/getFullSubject/getFullSubjectGate.js";
import type { CheckDataV2 } from "./checkTypes/CheckDataV2.js";
import { runCheckV2 } from "./runCheckV2.js";
import type { RunCheckResult } from "./types.js";

export const runCheckWithRollout = async ({
	ctx,
	body,
	requiredBalance,
	lockValue,
}: {
	ctx: AutumnContext;
	body: ParsedCheckParams;
	requiredBalance: number;
	lockValue?: number;
}): Promise<RunCheckResult<CheckData | CheckDataV2>> => {
	if (ctx.orgRateLimitDegraded) {
		// Strict posture: shed instead of admitting without evaluation (the
		// fail-open answer exists so an org-cap blip can't block traffic).
		if (isDepFailClosed()) {
			throw dependencyUnavailableError({
				reason: "check_unavailable",
				message:
					"Check is temporarily unavailable (org rate cap exceeded), please retry shortly.",
			});
		}
		return {
			checkData: null,
			response: getCheckFailOpenFallback({
				ctx,
				body,
				requiredBalance,
				error: new Error("org aggregate rate cap exceeded"),
				reason: "org_rate_limit",
			}) as Record<string, unknown>,
		};
	}

	return withRedisFailOpen<RunCheckResult<CheckData | CheckDataV2>>({
		source: "runCheckWithRollout",
		run: () => runCheckV2({ ctx, body, requiredBalance, lockValue }),
		alsoFailOpen: isFullSubjectGateRejection,
		fallback: (error) => {
			// Strict posture: shed instead of the 202-allowed fallback. The
			// throw propagates out of withRedisFailOpen to errorMiddleware.
			if (isDepFailClosed()) {
				throw dependencyUnavailableError({
					reason: "check_unavailable",
					message:
						"Check is temporarily unavailable, please retry shortly.",
				});
			}
			return {
				checkData: null,
				response: getCheckFailOpenFallback({
					ctx,
					body,
					requiredBalance,
					error,
					reason: "dependency_error",
				}) as Record<string, unknown>,
			};
		},
	});
};
