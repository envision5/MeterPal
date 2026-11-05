import { generateKsuid } from "@autumn/ksuid";
import {
	type CheckParams,
	ErrCode,
	type ParsedCheckParams,
	type ParsedLockParams,
	RecaseError,
} from "@autumn/shared";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const LOCK_ID_PREFIX = "lck";

/**
 * Normalise the `lock` field into a reservation the deduction path can use.
 *
 * Accepts the boolean shorthand (`lock: true` / `lock: false`) as well as
 * the object form.  The shorthand matters: the gateway and the published
 * docs use it, and a lock payload the server rejects turns a reservation
 * into a silent 400 that the caller cannot distinguish from "no hold".
 *
 * The lock id is derived, in order of preference, from:
 *   1. the caller-supplied `lock.lock_id`
 *   2. the caller's `idempotency_key` -- so a repeated check for the same
 *      request resolves to the same reservation instead of taking a second
 *      hold, and the duplicate is rejected by the receipt's atomic NX guard
 *   3. a freshly minted id
 */
export const parseCheckParamsForLock = ({
	params,
}: {
	params: CheckParams;
}): ParsedCheckParams => {
	const { lock } = params;

	if (lock === undefined || lock === false) {
		return {
			...params,
			lock: undefined,
		};
	}

	const lockOptions = lock === true ? { enabled: true as const } : lock;

	if (!lockOptions.enabled) {
		return {
			...params,
			lock: undefined,
		};
	}

	if (lockOptions.lock_id && lockOptions.lock_id.length > 256) {
		throw new RecaseError({
			message: "Lock ID cannot exceed 256 characters",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	if (
		lockOptions.expires_at !== undefined &&
		lockOptions.expires_at > Date.now() + ONE_DAY_MS
	) {
		throw new RecaseError({
			message: "Lock expires_at cannot be more than 1 day from now",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	const lockId =
		lockOptions.lock_id ??
		(params.idempotency_key
			? `${LOCK_ID_PREFIX}_${params.idempotency_key}`.slice(0, 256)
			: generateKsuid({ prefix: LOCK_ID_PREFIX }));
	const hashedKey = Bun.hash(lockId).toString();

	const finalLock: ParsedLockParams = {
		enabled: true,
		lock_id: lockId,
		hashed_key: hashedKey,
		expires_at: lockOptions.expires_at ?? undefined,
		overage_behavior: lockOptions.overage_behavior ?? undefined,
	};

	return {
		...params,
		lock: finalLock,
	};
};
