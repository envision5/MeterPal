import {
	ApiBaseEntitySchema,
	CustomerExpand,
	type FullCustomer,
	filterExpand,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { CusService } from "../../CusService.js";
import { getCusAutoTopupPurchaseLimits } from "../cusResponseUtils/getCusAutoTopupPurchaseLimits.js";
import { getCusTrialsUsed } from "../cusResponseUtils/getCusTrialsUsed.js";
import type { ApiCustomerExpandResult } from "./getApiCustomerExpandV2.js";

export const getApiCustomerExpand = async ({
	ctx,
	customerId,
	fullCus,
}: {
	ctx: AutumnContext;
	customerId?: string;
	fullCus?: FullCustomer;
}): Promise<ApiCustomerExpandResult> => {
	const { expand } = ctx;

	// Filter out synthetic nested expand paths handled within sub-builders.
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

	if (!fullCus) {
		fullCus = await CusService.getFull({
			ctx,
			idOrInternalId: customerId || "",
			expand: expand as CustomerExpand[],
			withEntities: expand.includes(CustomerExpand.Entities),
			withSubs: true,
		});
	}

	const getApiCusEntities = () => {
		if (expand.includes(CustomerExpand.Entities)) {
			return fullCus.entities.map((e) => ApiBaseEntitySchema.parse(e));
		}
		return undefined;
	};

	const cusExpand = expand as CustomerExpand[];

	const [trialsUsed, autoTopupsWithLimits] = await Promise.all([
		getCusTrialsUsed({
			ctx,
			fullCus,
			expand: cusExpand,
		}),
		getCusAutoTopupPurchaseLimits({
			ctx,
			internalCustomerId: fullCus.internal_id,
			autoTopupsConfig: fullCus.auto_topups,
			expand: cusExpand,
		}),
	]);

	return {
		trials_used: trialsUsed ?? undefined,
		entities: getApiCusEntities() ?? undefined,
		billing_controls_override: autoTopupsWithLimits
			? { auto_topups: autoTopupsWithLimits }
			: undefined,
	};
};
