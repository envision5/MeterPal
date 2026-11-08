import {
	apiBalanceToAllowed,
	CheckResponseV3Schema,
	FeatureType,
	orgToInStatuses,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { getCreditRateRequiredBalance } from "@/internal/features/creditSystemUtils.js";
import type { CheckDataV2 } from "./checkTypes/CheckDataV2.js";

export const getCheckResponseV2 = async ({
	ctx,
	checkData,
	requiredBalance,
	properties,
}: {
	ctx: AutumnContext;
	checkData: CheckDataV2;
	requiredBalance: number;
	properties?: Record<string, unknown> | null;
}) => {
	const {
		customerId,
		entityId,
		apiBalance,
		apiFlag,
		originalFeature,
		featureToUse,
		evaluationApiBalance,
		evaluationApiFlag,
		evaluationApiSubject,
	} = checkData;

	if (
		featureToUse.type === FeatureType.CreditSystem &&
		featureToUse.id !== originalFeature.id
	) {
		requiredBalance = getCreditRateRequiredBalance({
			fullSubject: checkData.fullSubject,
			sourceFeature: originalFeature,
			creditSystem: featureToUse,
			amount: requiredBalance,
			reverseOrder: ctx.org.config?.reverse_deduction_order,
			inStatuses: orgToInStatuses({ org: ctx.org }),
			eventProperties: properties ?? undefined,
		});
	}

	// Plain-check branch: this is a read-only evaluation against the cached
	// subject, NOT a reservation.  Concurrent plain checks can each pass off
	// the same balance snapshot — the reject/cap gate at track time (against
	// live Redis state) is what actually bounds spend.  Callers that need
	// admission to be exclusive must request a lock; the LiteLLM bridge does
	// so by default and refuses admits returned without a reservation id.
	if (!evaluationApiBalance && !evaluationApiFlag) {
		return CheckResponseV3Schema.parse({
			allowed: false,
			customer_id: customerId || "",
			entity_id: entityId,
			required_balance: requiredBalance,
			balance: apiBalance ?? null,
			flag: apiFlag ?? null,
		});
	}

	const allowed = evaluationApiFlag
		? true
		: evaluationApiBalance
			? apiBalanceToAllowed({
					apiBalance: evaluationApiBalance,
					apiSubject: evaluationApiSubject,
					feature: featureToUse,
					requiredBalance,
					originalFeature,
					properties,
				}).allowed
			: false;

	return CheckResponseV3Schema.parse({
		allowed,
		customer_id: customerId || "",
		entity_id: entityId,
		required_balance: requiredBalance,
		balance: apiBalance ?? null,
		flag: apiFlag ?? null,
	});
};
