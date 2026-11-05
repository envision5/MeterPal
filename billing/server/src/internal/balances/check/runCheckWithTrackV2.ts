import {
	type ApiBalanceV1,
	ApiVersion,
	CheckResponseV3Schema,
	ErrCode,
	FeatureType,
	featureUtils,
	InsufficientBalanceError,
	InternalError,
	orgToInStatuses,
	type ParsedCheckParams,
	RecaseError,
	Scopes,
	type TrackParams,
	UsageLimitExceededError,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { getTrackFeatureDeductions } from "@/internal/balances/track/utils/getFeatureDeductions.js";
import { runTrackV3 } from "@/internal/balances/track/v3/runTrackV3.js";
import { buildLockScheduleName } from "@/internal/balances/utils/lock/buildLockScheduleName.js";
import { getCreditRateRequiredBalance } from "@/internal/features/creditSystemUtils.js";
import { workflows } from "@/queue/workflows.js";
import type { CheckDataV2 } from "./checkTypes/CheckDataV2.js";
import { getCheckResponseV2 } from "./getCheckResponseV2.js";

export const runCheckWithTrackV2 = async ({
	ctx,
	body,
	requiredBalance,
	lockValue,
	checkData,
}: {
	ctx: AutumnContext;
	body: ParsedCheckParams;
	requiredBalance: number;
	lockValue?: number;
	checkData: CheckDataV2;
}) => {
	// Two different numbers, and conflating them is what made the
	// reservation useless:
	//
	//   requiredBalance  the caller's minimum-balance policy -- the balance
	//                    a call may start with.
	//   lockValue        what this request can cost, priced at the org's
	//                    rates.  This is what the hold reserves.
	//
	// A hold sized by the policy floor is a flat amount that does not bound
	// the request, so N concurrent requests could each take it and spend
	// past it.
	const holdValue = lockValue ?? requiredBalance;
	if (!body.feature_id) {
		throw new InternalError({
			message: "ran check with track but no feature ID",
		});
	}

	if (ctx.isPublic) {
		throw new RecaseError({
			message:
				"Can't use send_event: true with a publishable key. Use your secret API key instead.",
			statusCode: 400,
		});
	}

	// send_event DEBITS the customer.  The check route carries only
	// balances.read, so a key scoped read-only could otherwise move money.
	// Publishable keys are refused above; scoped keys must prove
	// balances.write.  Unscoped legacy auth (empty scopes) keeps the legacy
	// fail-open behavior.
	if (ctx.scopes?.length && !ctx.scopes.includes(Scopes.Balances.Write)) {
		throw new RecaseError({
			message:
				"send_event: true requires the balances.write scope. This key is read-only.",
			code: ErrCode.InsufficientScopes,
			statusCode: 403,
		});
	}

	if (body.lock && featureUtils.isAllocated(checkData.featureToUse)) {
		throw new RecaseError({
			message: "Lock is not supported for allocated features",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	if (checkData.originalFeature.type === FeatureType.Boolean) {
		throw new RecaseError({
			message:
				"send_event cannot be used with boolean features, which are flags rather than usage-tracked.",
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	// The threshold is the caller's minimum-balance policy and it applies on
	// the lock path too.  Without this the threshold would only be enforced
	// by the deduction, and the deduction now reserves the request's own
	// cost -- which for a cheap request is less than the policy floor, so a
	// customer below the floor would be admitted.
	if (body.lock?.enabled && requiredBalance > 0) {
		const thresholdCheck = await getCheckResponseV2({
			ctx,
			checkData,
			requiredBalance,
			properties: body.properties,
		});
		if (!thresholdCheck.allowed) {
			return thresholdCheck;
		}
	}

	// No entitlement means the Lua deduction script no-ops successfully,
	// which would incorrectly surface as allowed: true.
	if (
		!checkData.evaluationApiBalance &&
		(requiredBalance > 0 || checkData.apiBalance)
	) {
		return getCheckResponseV2({
			ctx,
			checkData,
			requiredBalance,
			properties: body.properties,
		});
	}

	const { featureToUse, originalFeature } = checkData;
	const responseRequiredBalance =
		featureToUse.type === FeatureType.CreditSystem &&
		featureToUse.id !== originalFeature.id
			? getCreditRateRequiredBalance({
					fullSubject: checkData.fullSubject,
					sourceFeature: originalFeature,
					creditSystem: featureToUse,
					amount: requiredBalance,
					reverseOrder: ctx.org.config?.reverse_deduction_order,
					inStatuses: orgToInStatuses({ org: ctx.org }),
					eventProperties: body.properties,
				})
			: requiredBalance;

	const featureDeductions = getTrackFeatureDeductions({
		ctx,
		featureId: body.feature_id,
		lock: body.lock,
		value: holdValue,
	}).map((deduction) => ({ ...deduction, enforceOverdueBlock: true }));

	const trackBody: TrackParams = {
		customer_id: body.customer_id,
		entity_id: body.entity_id,
		feature_id: body.feature_id,
		value: holdValue,
		properties: body.properties,
		skip_event: body.skip_event,
		overage_behavior: body.lock?.overage_behavior ?? "reject",
		lock: body.lock,
	};

	let allowed = true;
	let trackBalances: Record<string, ApiBalanceV1 | null> | undefined;

	try {
		const response = await runTrackV3({
			ctx,
			body: trackBody,
			featureDeductions,
			apiVersion: ApiVersion.V2_1,
		});

		const trackedBalance =
			response.balance ?? response.balances?.[body.feature_id] ?? undefined;
		checkData.apiBalance = trackedBalance ?? undefined;
		checkData.evaluationApiBalance = trackedBalance ?? undefined;
		trackBalances = response.balances;
	} catch (error) {
		if (
			error instanceof InsufficientBalanceError ||
			error instanceof UsageLimitExceededError
		) {
			allowed = false;
		} else {
			throw error;
		}
	}

	if (body.lock?.expires_at && allowed) {
		try {
			const scheduleName = buildLockScheduleName({
				orgId: ctx.org.id,
				env: ctx.env,
				hashedKey: body.lock.hashed_key,
			});

			await workflows.triggerExpireLockReceipt(
				{
					orgId: ctx.org.id,
					env: ctx.env,
					customerId: body.customer_id,
					lockId: body.lock.lock_id,
					hashedKey: body.lock.hashed_key,
				},
				{
					scheduleAt: new Date(body.lock.expires_at),
					scheduleName,
				},
			);
		} catch (error) {
			ctx.logger.error(`Failed to schedule lock expiration: ${error}`);
		}
	}

	return CheckResponseV3Schema.parse({
		allowed,
		customer_id: checkData.customerId || "",
		entity_id: checkData.entityId,
		required_balance: responseRequiredBalance,
		balance: checkData.apiBalance ?? null,
		balances: trackBalances,
		flag: checkData.apiFlag ?? null,
		// The reservation, when one was actually taken.  Without it in the
		// response the caller has no id to finalize, so the hold could only
		// ever be released by its expiry.
		...(allowed && body.lock?.lock_id
			? {
					lock: {
						lock_id: body.lock.lock_id,
						expires_at: body.lock.expires_at,
					},
				}
			: {}),
	});
};
