import {
	CusProductStatus,
	type customerProducts,
	type customers,
	type FullCusProduct,
	type FullProduct,
} from "@autumn/shared";
import { customerProductToDefaultProduct } from "@utils/cusProductUtils/convertCusProduct/customerProductToDefaultProduct";
import type { InferSelectModel } from "drizzle-orm";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { executeAutumnBillingPlan } from "@/internal/billing/v2/execute/executeAutumnBillingPlan.js";
import { applyPooledBalanceCustomerProductTransitions } from "@/internal/billing/v2/pooledBalances/execute/applyPooledBalanceCustomerProductTransitions.js";
import { sendBillingUpdatedWebhook } from "@/internal/billing/v2/workflows/sendBillingUpdatedWebhook/sendBillingUpdatedWebhook";
import { billingPlanToSendProductsUpdated } from "@/internal/billing/v2/workflows/sendProductsUpdated/billingPlanToSendProductsUpdated";
import { CusService } from "@/internal/customers/CusService";
import { activateFreeDefaultProduct } from "@/internal/customers/cusProducts/actions/activateFreeDefaultProduct";
import { tryProcessRevertExpiry } from "@/internal/customers/cusProducts/actions/revertTrialExpiry";
import {
	ACTIVE_STATUSES,
	CusProductService,
} from "@/internal/customers/cusProducts/CusProductService";
import { deleteCachedFullCustomer } from "@/internal/customers/cusUtils/fullCustomerCacheUtils/deleteCachedFullCustomer";

export const processExpiredTrialRow = async ({
	ctx,
	customerProduct,
	customer,
	defaultProducts,
}: {
	ctx: AutumnContext;
	customerProduct: InferSelectModel<typeof customerProducts>;
	customer: InferSelectModel<typeof customers>;
	defaultProducts: FullProduct[];
}) => {
	// Revert path owns its own webhook emission.
	const reverted = await tryProcessRevertExpiry({
		ctx,
		customerProduct,
		customerId: customer.id ?? "",
	});
	if (reverted) return;

	// Standard path: snapshot fullCustomer BEFORE mutations so the webhook
	// payload reflects pre-expiry state in `previous_attributes`. Default
	// RELEVANT_STATUSES is sufficient — the trial cusProduct is Active
	// (with a past trial_ends_at) at this point.
	const fullCustomer = await CusService.getFull({
		ctx,
		idOrInternalId: customer.internal_id,
		withEntities: true,
		withSubs: true,
	});

	const customerPageTrialCusProduct = fullCustomer.customer_products.find(
		(cp) => cp.id === customerProduct.id,
	);
	const trialFullCusProduct =
		customerPageTrialCusProduct ??
		(await CusProductService.getFull({
			db: ctx.db,
			id: customerProduct.id,
			inStatuses: [CusProductStatus.Active, CusProductStatus.PastDue],
		}));
	if (!trialFullCusProduct) return;

	const originalFullCustomer = customerPageTrialCusProduct
		? fullCustomer
		: {
				...fullCustomer,
				customer_products: [
					...fullCustomer.customer_products,
					trialFullCusProduct,
				],
			};

	const defaultProduct = customerProductToDefaultProduct({
		ctx,
		customerProduct: trialFullCusProduct,
		defaultProducts,
	});

	// Claim before the first mutation: exactly one concurrent instance gets to
	// flip the row out of ACTIVE_STATUSES and run the side-effect chain below
	// (default activation, billing plan, pooled transitions, webhooks). The
	// conditional UPDATE re-evaluates its predicate after any competing
	// transaction commits, so the winner is decided by the row lock, not by
	// the stale cron read — a loser sees 0 rows and skips, no duplicate
	// transitions or trial_ended webhooks.
	const claim = await CusProductService.update({
		ctx,
		cusProductId: trialFullCusProduct.id,
		updates: { status: CusProductStatus.Expired },
		inStatuses: ACTIVE_STATUSES,
	});
	if (claim.length === 0) return;

	let activatedDefault: FullCusProduct | undefined;
	if (defaultProduct) {
		activatedDefault = await activateFreeDefaultProduct({
			ctx,
			customerProduct: trialFullCusProduct,
			fullCustomer: originalFullCustomer,
			defaultProduct,
		});
	}
	// Executing through the shared plan runs the license lifecycle when the
	// expiring trial carried license state.
	await executeAutumnBillingPlan({
		ctx,
		autumnBillingPlan: {
			customerId: fullCustomer.id || fullCustomer.internal_id,
			insertCustomerProducts: [],
			updateCustomerProducts: [
				{
					customerProduct: trialFullCusProduct,
					updates: { status: CusProductStatus.Expired },
				},
			],
		},
	});

	// Default activation already executes the outgoing and incoming transition together.
	if (!activatedDefault) {
		await applyPooledBalanceCustomerProductTransitions({
			ctx,
			fullCustomer: originalFullCustomer,
			outgoingCustomerProducts: [trialFullCusProduct],
			incomingCustomerProducts: [],
			now: Date.now(),
		});
	}

	await deleteCachedFullCustomer({
		ctx,
		customerId: fullCustomer.id ?? "",
		source: "productCron",
	});

	const autumnBillingPlan = {
		customerId: originalFullCustomer.id ?? originalFullCustomer.internal_id,
		insertCustomerProducts: activatedDefault ? [activatedDefault] : [],
		updateCustomerProducts: [
			{
				customerProduct: trialFullCusProduct,
				updates: { status: CusProductStatus.Expired },
			},
		],
	};

	await billingPlanToSendProductsUpdated({
		ctx,
		autumnBillingPlan,
		billingContext: { fullCustomer: originalFullCustomer },
	});

	void sendBillingUpdatedWebhook({
		ctx,
		autumnBillingPlan,
		originalFullCustomer,
		tags: ["trial_ended"],
	});
};
