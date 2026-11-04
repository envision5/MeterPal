import {
	BillingVersion,
	hasCustomItems,
	type UpdateSubscriptionBillingContext,
	type UpdateSubscriptionBillingContextOverride,
	type UpdateSubscriptionV1Params,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { setupDefaultProductContext } from "@/internal/billing/v2/actions/updateSubscription/setup/setupDefaultProductContext";
import { setupUpdateLicenseQuantities } from "@/internal/billing/v2/actions/updateSubscription/setup/setupUpdateLicenseQuantities";
import { setupUpdateSubscriptionProductContext } from "@/internal/billing/v2/actions/updateSubscription/setup/setupUpdateSubscriptionProductContext";
import { handleEntityLicenseAssignmentErrors } from "@/internal/billing/v2/common/errors/handleEntityLicenseAssignmentErrors";
import { setupCustomerLicenseBillingContext } from "@/internal/billing/v2/setup/customerLicenseBillingContext/setupCustomerLicenseBillingContext";
import { fetchStoredLineItemsForSubscriptionBilling } from "@/internal/billing/v2/setup/fetchStoredLineItemsForSubscriptionBilling";
import { setupAdjustableQuantities } from "@/internal/billing/v2/setup/setupAdjustableQuantities";
import { setupAnchorResetRefund } from "@/internal/billing/v2/setup/setupAnchorResetRefund";
import { setupBillingCycleAnchor } from "@/internal/billing/v2/setup/setupBillingCycleAnchor";
import {
	setupCancelAction,
	shouldSuppressUnpaidCycleCredit,
} from "@/internal/billing/v2/setup/setupCancelMode";
import { setupFeatureQuantitiesContext } from "@/internal/billing/v2/setup/setupFeatureQuantitiesContext";
import { setupFullCustomerContext } from "@/internal/billing/v2/setup/setupFullCustomerContext";
import { setupIgnoreProrationBehavior } from "@/internal/billing/v2/setup/setupIgnoreProrationBehavior";
import { setupInvoiceModeContext } from "@/internal/billing/v2/setup/setupInvoiceModeContext";
import { setupResetCycleAnchor } from "@/internal/billing/v2/setup/setupResetCycleAnchor";
import { isRevertTrialContext } from "@/internal/billing/v2/setup/trialContext/isRevertTrialContext";
import { resolveCarryOverUsagesParam } from "@/internal/billing/v2/utils/handleCarryOvers/resolveCarryOverUsagesParam";
import { setupAttachCheckoutMode } from "../../attach/setup/setupAttachCheckoutMode";
import { setupUpdateSubscriptionIntent } from "./setupUpdateSubscriptionIntent";
import { setupUpdateSubscriptionTrialContext } from "./setupUpdateSubscriptionTrialContext";

const FIELDS_WITH_BILLING_CHANGES = [
	"feature_quantities",
	"license_quantities",
	"version",
	"customize",
	"cancel_action",
	"billing_cycle_anchor",
	"discounts",
	"remove_discounts",
	"custom_line_items",
] as const satisfies (keyof UpdateSubscriptionV1Params)[];

/**
 * Fetch the context for updating a subscription
 * @param ctx - The context
 * @param body - The body of the request
 * @returns The update subscription context
 */
export const setupUpdateSubscriptionBillingContext = async ({
	ctx,
	params,
	preview = false,
	contextOverride = {},
}: {
	ctx: AutumnContext;
	params: UpdateSubscriptionV1Params;
	preview?: boolean;
	contextOverride?: UpdateSubscriptionBillingContextOverride;
}): Promise<UpdateSubscriptionBillingContext> => {
	const fullCustomer =
		contextOverride.projectedFullCustomer ??
		(await setupFullCustomerContext({
			ctx,
			params,
		}));

	// Before product resolution: a seat-holding entity's plan is managed
	// through its license, never updated directly.
	handleEntityLicenseAssignmentErrors({ fullCustomer });

	const {
		customerProduct,
		fullProduct,
		patchContext,
		customPrices,
		customEnts,
		insertPlanLicenses,
		customerLicenseQuantities: productContextLicenseQuantities,
		isUpdatingFreeCustomerProduct,
	} = await setupUpdateSubscriptionProductContext({
		ctx,
		fullCustomer,
		params,
		contextOverride,
	});

	const featureQuantities = setupFeatureQuantitiesContext({
		ctx,
		featureQuantitiesParams: params,
		fullProduct,
		currentCustomerProduct: customerProduct,
		contextOverride,
		initializeUndefinedQuantities: true,
	});

	const customerLicenseQuantities =
		productContextLicenseQuantities ??
		setupUpdateLicenseQuantities({ params, fullProduct, customerProduct });

	const customerLicenseBillingContext =
		await setupCustomerLicenseBillingContext({ ctx, fullCustomer });
	const billingRelatedFields = Object.keys(params).filter((key) =>
		FIELDS_WITH_BILLING_CHANGES.includes(
			key as (typeof FIELDS_WITH_BILLING_CHANGES)[number],
		),
	);

	const skipBillingFetching =
		contextOverride.skipBillingFetching === true ||
		billingRelatedFields.length === 0 ||
		isUpdatingFreeCustomerProduct;

	const skipBillingChangesBase =
		skipBillingFetching ||
		params.no_billing_changes === true ||
		params.processor_subscription_id !== undefined;

	const currentEpochMs = Date.now();

	// 1. Setup trial context first
	const trialContext = setupUpdateSubscriptionTrialContext({
		customerProduct,
		currentEpochMs,
		params,
		fullProduct,
	});

	const skipBillingChanges =
		skipBillingChangesBase || isRevertTrialContext({ trialContext });

	// 3. Determine final anchor based on product transitions
	let billingCycleAnchorMs = setupBillingCycleAnchor({
		customerProduct,
		newFullProduct: fullProduct,
		trialContext,
		currentEpochMs,
		requestedBillingCycleAnchor: params.billing_cycle_anchor,
	});

	// 4. Trial ends at overrides reset cycle anchor
	if (trialContext?.trialEndsAt) {
		billingCycleAnchorMs = trialContext.trialEndsAt;
	}

	const resetCycleAnchorMs = setupResetCycleAnchor({
		billingCycleAnchorMs,
		customerProduct,
		newFullProduct: fullProduct,
	});

	const invoiceMode = await setupInvoiceModeContext({
		ctx,
		fullCustomer,
		params,
	});
	const isCustom =
		contextOverride.forceIsCustom !== undefined
			? contextOverride.forceIsCustom
			: hasCustomItems(params.customize);

	const defaultProduct = await setupDefaultProductContext({
		ctx,
		params,
		customerProduct,
	});

	const cancelAction = setupCancelAction({
		params,
		org: ctx.org,
		customerProduct,
	});

	// A past_due immediate cancel (resolved from end-of-cycle OR requested directly) must not
	// credit the unpaid cycle — the open invoice is voided instead.
	const suppressUnpaidCycleCredit = shouldSuppressUnpaidCycleCredit({
		cancelAction,
		org: ctx.org,
		customerProduct,
	});

	let checkoutMode = setupAttachCheckoutMode({
		redirectMode: params.redirect_mode ?? "if_required",
		attachProduct: fullProduct,
		trialContext,
		invoiceMode,
	});

	checkoutMode =
		params.redirect_mode === "always" && checkoutMode ? checkoutMode : null; // For update subscription, always use autumn_checkout for now

	const intent = setupUpdateSubscriptionIntent({
		params,
		checkoutMode,
		customerProduct,
	});

	const { storedChargeLineItems, storedRefundLineItems } =
		await fetchStoredLineItemsForSubscriptionBilling({
			db: ctx.db,
			fullCustomer,
			processorSubscriptionId: customerProduct.subscription_ids?.[0],
			outgoingCusProductIds: [customerProduct.id],
		});

	return {
		intent,
		fullCustomer,
		fullProducts: [fullProduct],
		customerProduct,
		patchContext,
		defaultProduct,
		cancelAction,
		recalculateBalances: params.recalculate_balances?.enabled === true,
		refundLastPayment: params.refund_last_payment,
		subscriptionParams: params.subscription_params,

		currentEpochMs,
		billingCycleAnchorMs,
		resetCycleAnchorMs,
		requestedBillingCycleAnchor: params.billing_cycle_anchor,
		requestedProrationBehavior: suppressUnpaidCycleCredit
			? "none"
			: setupIgnoreProrationBehavior({ intent })
				? undefined
				: params.proration_behavior,

		invoiceMode,
		featureQuantities,
		adjustableFeatureQuantities: setupAdjustableQuantities({ params }),
		customerLicenseQuantities,
		customerLicenseBillingContext,
		insertPlanLicenses,

		customPrices,
		customEnts,
		trialContext,
		isCustom,

		billingVersion: contextOverride.billingVersion ?? BillingVersion.V2,

		actionSource: "updateSubscription",

		skipBillingChanges,

		storedChargeLineItems,
		storedRefundLineItems,

		checkoutMode,

		anchorResetRefund: setupAnchorResetRefund({
			billingCycleAnchor: params.billing_cycle_anchor,
			prorationBehavior: params.proration_behavior,
			outgoingCustomerProduct: customerProduct,
		}),

		chargeExistingOverages: contextOverride.chargeExistingOverages,
		skipExistingUsageCarry: contextOverride.skipExistingUsageCarry,
		carryOverUsages: await resolveCarryOverUsagesParam({
			ctx,
			carryOverUsages: params.carry_over_usages,
		}),
	};
};
