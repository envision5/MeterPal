import {
	ApiBaseEntitySchema,
	type ApiCusExpand,
	type AutoTopupResponse,
	CustomerExpand,
	type FullSubject,
	filterExpand,
	fullSubjectToFullCustomer,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { EntityService } from "@/internal/api/entities/EntityService.js";
import { getCusAutoTopupPurchaseLimits } from "../cusResponseUtils/getCusAutoTopupPurchaseLimits.js";
import { getCusTrialsUsed } from "../cusResponseUtils/getCusTrialsUsed.js";

/**
 * Result of expand resolution. In addition to the standard `ApiCusExpand`
 * fields, this carries an optional override for `billing_controls.auto_topups`
 * which the caller merges into the base customer's `billing_controls` block.
 */
export type ApiCustomerExpandResult = ApiCusExpand & {
	billing_controls_override?: {
		auto_topups: AutoTopupResponse[];
	};
};

/**
 * Build expand fields directly from a FullSubject — no extra FullCustomer fetch.
 * For entities, queries the DB directly (capped at 1000).
 */
export const getApiCustomerExpandV2 = async ({
	ctx,
	fullSubject,
	autoTopupsConfig,
}: {
	ctx: AutumnContext;
	fullSubject: FullSubject;
	/** Overrides the raw customer-level auto_topups (e.g. plan-merged list). */
	autoTopupsConfig?: AutoTopupResponse[];
}): Promise<ApiCustomerExpandResult> => {
	const { expand } = ctx;

	const filteredExpand = filterExpand({
		expand,
		filter: [
			CustomerExpand.BalancesFeature,
			CustomerExpand.FlagsFeature,
			CustomerExpand.SubscriptionsPlan,
			CustomerExpand.Invoices,
		],
	});

	if (filteredExpand.length === 0) return {};

	const cusExpand = expand as CustomerExpand[];
	const fullCus = fullSubjectToFullCustomer({ fullSubject });

	const getApiEntities = async () => {
		if (!cusExpand.includes(CustomerExpand.Entities)) return undefined;

		const entities = await EntityService.list({
			db: ctx.db,
			internalCustomerId: fullCus.internal_id,
			limit: 1000,
		});

		return entities.map((e) =>
			ApiBaseEntitySchema.parse({
				...e,
				customer_id: fullSubject.customer.id,
			}),
		);
	};

	const [entities, trialsUsed, autoTopupsWithLimits] = await Promise.all([
		getApiEntities(),
		getCusTrialsUsed({
			ctx,
			fullCus,
			expand: cusExpand,
		}),
		getCusAutoTopupPurchaseLimits({
			ctx,
			internalCustomerId: fullCus.internal_id,
			autoTopupsConfig: autoTopupsConfig ?? fullCus.auto_topups,
			expand: cusExpand,
		}),
	]);

	return {
		trials_used: trialsUsed ?? undefined,
		entities: entities ?? undefined,
		billing_controls_override: autoTopupsWithLimits
			? { auto_topups: autoTopupsWithLimits }
			: undefined,
	};
};
