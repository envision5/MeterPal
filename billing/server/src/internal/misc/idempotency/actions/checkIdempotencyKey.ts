import { ErrCode, RecaseError } from "@autumn/shared";
import { claimDynamoIdempotencyKey } from "@/external/aws/dynamodb/idempotencyKeys/operations/claimDynamoIdempotencyKey.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import {
	dependencyUnavailableError,
	isDepFailClosed,
} from "@/internal/misc/dependencyPolicy/dependencyPolicy.js";
import { buildIdempotencyStorageKey } from "../idempotencyKeyUtils.js";

/** Claims the key in DynamoDB: a duplicate 409s, an unavailable store fails
 *  open so an outage can't reject live traffic — unless the deployment runs
 *  DEP_FAILURE_POLICY=fail_closed, where it sheds with a 503 instead. */
export const checkIdempotencyKey = async ({
	ctx,
	idempotencyKey,
	ttlMs,
}: {
	ctx: AutumnContext;
	idempotencyKey: string;
	/** Org-configurable per route group — defaults to 24h in the store. */
	ttlMs?: number;
}): Promise<void> => {
	const { logger } = ctx;
	const { hashedKey, storageKey } = buildIdempotencyStorageKey({
		orgId: ctx.org.id,
		env: ctx.env,
		idempotencyKey,
	});

	logger.info(
		`[checkIdempotencyKey] claiming idempotency key ${idempotencyKey}, hash: ${hashedKey}`,
	);

	const result = await claimDynamoIdempotencyKey({ storageKey, ttlMs, logger });

	if (result === "unavailable") {
		if (!isDepFailClosed()) return;
		throw dependencyUnavailableError({
			reason: "idempotency_store_unavailable",
			message:
				"Idempotency store is temporarily unavailable, please retry shortly.",
		});
	}

	if (result === "duplicate") {
		throw new RecaseError({
			message: `Another request with idempotency key ${idempotencyKey} has already been received`,
			code: ErrCode.DuplicateIdempotencyKey,
			statusCode: 409,
		});
	}
};
