import {
	BillingVersion,
	customerProductHasSubscription,
	type FullProduct,
	getTargetSubscriptionCusProduct,
	type InvoiceMode,
	isFreeProduct,
	isOneOffProduct,
	isPastStartDate,
	isProductPaidAndRecurring,
	type MultiAttachBillingContext,
	type MultiAttachParamsV0,
	type MultiAttachProductContext,
	notNullish,
	orgToReturnUrl,
	RecaseError,
	resolveCustomerCurrency,
} from "@autumn/shared";
import type { FreeTrialParamsV1 } from "@shared/api/common/freeTrial/freeTrialParamsV1";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { setupAttachProductContext } from "@/internal/billing/v2/actions/attach/setup/setupAttachProductContext";
import { setupAttachTransitionContext } from "@/internal/billing/v2/actions/attach/setup/setupAttachTransitionContext";
import { setupCustomerLicenseBillingContext } from "@/internal/billing/v2/setup/customerLicenseBillingContext/setupCustomerLicenseBillingContext";
import {
	customerProductsToProcessorSubscriptionIds,
	filterCustomerProductsByProcessorSubscriptionId,
} from "@/internal/billing/v2/utils/customerProducts/processorSubscriptionIds";
import { fetchStoredLineItemsForSubscriptionBilling } from "@/internal/billing/v2/setup/fetchStoredLineItemsForSubscriptionBilling";
import { setupAnchorResetRefund } from "@/internal/billing/v2/setup/setupAnchorResetRefund";
import { setupBillingCycleAnchor } from "@/internal/billing/v2/setup/setupBillingCycleAnchor";
import { setupFeatureQuantitiesContext } from "@/internal/billing/v2/setup/setupFeatureQuantitiesContext";
import { setupFullCustomerContext } from "@/internal/billing/v2/setup/setupFullCustomerContext";
import { setupInvoiceModeContext } from "@/internal/billing/v2/setup/setupInvoiceModeContext";
import { setupResetCycleAnchor } from "@/internal/billing/v2/setup/setupResetCycleAnchor";
import {
	applyProductTrialConfig,
	handleFreeTrialParam,
} from "@/internal/billing/v2/setup/trialContext";
import { isRevertTrialContext } from "@/internal/billing/v2/setup/trialContext/isRevertTrialContext";

type ImmediateMultiProductParams = MultiAttachParamsV0 & {
	no_billing_changes?: boolean;
};

const getSubscriptionTarget = ({
	productContext,
}: {
	productContext: MultiAttachProductContext;
}) => {
	const { currentCustomerProduct, scheduledCustomerProduct, fullProduct } =
		productContext;

	if (customerProductHasSubscription(currentCustomerProduct)) {
		return currentCustomerProduct;
	}
	if (customerProductHasSubscription(scheduledCustomerProduct)) {
		return scheduledCustomerProduct;
	}
	if (!isProductPaidAndRecurring(fullProduct)) return undefined;

	return getTargetSubscriptionCusProduct({
		fullCus: productContext.fullCustomer,
		productId: fullProduct.id,
		productGroup: fullProduct.group ?? "",
		cusProductId: currentCustomerProduct?.id ?? scheduledCustomerProduct?.id,
	});
};

/** Resolve checkout mode for immediate multi-product billing. */
const setupImmediateMultiProductCheckoutMode = ({
	redirectMode,
	invoiceMode,
	fullProducts,
}: {
	redirectMode?: MultiAttachParamsV0["redirect_mode"];
	invoiceMode?: InvoiceMode;
	fullProducts: FullProduct[];
}) => {
	if (redirectMode === "never") {
		return null;
	}

	if (invoiceMode) {
		return null;
	}

	if (fullProducts.every((product) => isFreeProduct({ product }))) {
		return null;
	}

	return "processor_checkout";
};

/** Resolve trial behavior for immediate multi-product billing. */
const setupImmediateMultiProductTrialContext = async ({
	ctx,
	freeTrialParam,
	fullCustomer,
	fullProducts,
	currentEpochMs,
}: {
	ctx: AutumnContext;
	freeTrialParam?: FreeTrialParamsV1 | null;
	fullCustomer: MultiAttachBillingContext["fullCustomer"];
	fullProducts: MultiAttachBillingContext["fullProducts"];
	currentEpochMs: number;
}) => {
	const paidRecurringProduct = fullProducts.find((product) =>
		isProductPaidAndRecurring(product),
	);
	const recurringProduct = fullProducts.find(
		(product) => !isOneOffProduct({ product }),
	);
	const targetProduct =
		paidRecurringProduct ?? recurringProduct ?? fullProducts[0];

	if (!targetProduct) {
		return undefined;
	}

	if (freeTrialParam !== undefined) {
		return handleFreeTrialParam({
			freeTrialParams: freeTrialParam,
			fullProduct: targetProduct,
			currentEpochMs,
		});
	}

	const productWithTrial = fullProducts.find((product) => product.free_trial);

	if (!productWithTrial) {
		return undefined;
	}

	return applyProductTrialConfig({
		ctx,
		fullProduct: productWithTrial,
		fullCustomer,
		currentEpochMs,
	});
};

/** Build billing context for immediate multi-product billing. */
export const setupImmediateMultiProductBillingContext = async ({
	ctx,
	params,
	preview = false,
	billingStartsAt,
	billingStartsAtToleranceMs,
}: {
	ctx: AutumnContext;
	params: ImmediateMultiProductParams;
	preview?: boolean;
	billingStartsAt?: number;
	billingStartsAtToleranceMs?: number;
}): Promise<MultiAttachBillingContext> => {
	const fullCustomer = await setupFullCustomerContext({
		ctx,
		params,
	});
	const scopedFullCustomers = new Map<
		string | undefined,
		Promise<typeof fullCustomer>
	>([[params.entity_id, Promise.resolve(fullCustomer)]]);
	const getScopedFullCustomer = (planEntityId?: string | null) => {
		let entityId = planEntityId;
		if (entityId === undefined) entityId = params.entity_id;
		if (entityId === null) entityId = undefined;

		const cached = scopedFullCustomers.get(entityId);
		if (cached) return cached;

		const pending = setupFullCustomerContext({
			ctx,
			params: { customer_id: params.customer_id, entity_id: entityId },
		});
		scopedFullCustomers.set(entityId, pending);
		return pending;
	};

	const productContexts: MultiAttachProductContext[] = await Promise.all(
		(params.plans ?? []).map(async (plan) => {
			const scopedFullCustomer = await getScopedFullCustomer(plan.entity_id);

			const { fullProduct, customPrices, customEnts, insertPlanLicenses } =
				await setupAttachProductContext({
					ctx,
					params: {
						customer_id: params.customer_id,
						plan_id: plan.plan_id,
						customize: plan.customize,
						version: plan.version,
					},
					fullCustomer: scopedFullCustomer,
				});

			const { currentCustomerProduct, scheduledCustomerProduct } =
				setupAttachTransitionContext({
					fullCustomer: scopedFullCustomer,
					attachProduct: fullProduct,
				});

			const featureQuantities = setupFeatureQuantitiesContext({
				ctx,
				featureQuantitiesParams: {
					feature_quantities: plan.feature_quantities,
				},
				fullProduct,
				currentCustomerProduct,
				initializeUndefinedQuantities: true,
			});

			return {
				fullProduct,
				customPrices: customPrices ?? [],
				customEnts: customEnts ?? [],
				featureQuantities,
				insertPlanLicenses,
				fullCustomer: scopedFullCustomer,
				currentCustomerProduct,
				scheduledCustomerProduct,
				externalId: plan.subscription_id,
			};
		}),
	);

	const fullProducts = productContexts.map(
		(productContext) => productContext.fullProduct,
	);
	const [firstProduct] = fullProducts;

	if (!firstProduct) {
		throw new Error("setupImmediateMultiProductBillingContext requires plans");
	}

	const hasSubscriptionTransition = productContexts.some(
		({ currentCustomerProduct, scheduledCustomerProduct }) =>
			customerProductHasSubscription(currentCustomerProduct) ||
			customerProductHasSubscription(scheduledCustomerProduct),
	);
	const forceNewSubscription =
		params.new_billing_subscription === true && !hasSubscriptionTransition;
	const targetCustomerProducts = forceNewSubscription
		? []
		: productContexts
				.map((productContext) => getSubscriptionTarget({ productContext }))
				.filter(notNullish);
	const subscriptionIds = customerProductsToProcessorSubscriptionIds({
		customerProducts: targetCustomerProducts,
	});

	if (subscriptionIds.length > 1) {
		throw new RecaseError({
			message: "Cannot update products across multiple existing subscriptions.",
			statusCode: 400,
		});
	}

	const [subscriptionId] = subscriptionIds;
	const [targetCustomerProduct] = filterCustomerProductsByProcessorSubscriptionId({
		customerProducts: targetCustomerProducts,
		processorSubscriptionId: subscriptionId,
	});

	const invoiceMode = await setupInvoiceModeContext({
		ctx,
		fullCustomer,
		params,
	});
	const currentEpochMs = Date.now();
	const trialContext = await setupImmediateMultiProductTrialContext({
		ctx,
		freeTrialParam: params.free_trial,
		fullCustomer,
		fullProducts,
		currentEpochMs,
	});

	let billingCycleAnchorMs = setupBillingCycleAnchor({
		customerProduct: undefined,
		newFullProduct: firstProduct,
		trialContext,
		currentEpochMs,
		requestedBillingCycleAnchor: params.billing_cycle_anchor,
		billingStartsAt,
		billingStartsAtToleranceMs,
	});

	if (trialContext?.trialEndsAt) {
		billingCycleAnchorMs = trialContext.trialEndsAt;
	}

	const subscriptionBackdateStartMs =
		billingStartsAt !== undefined &&
		isPastStartDate(billingStartsAt, currentEpochMs, billingStartsAtToleranceMs)
			? billingStartsAt
			: undefined;

	// Reset anchor derives from billingCycleAnchorMs, which setupBillingCycleAnchor
	// already aligns to a backdated start.
	const resetCycleAnchorMs = setupResetCycleAnchor({
		billingCycleAnchorMs,
		customerProduct: undefined,
		newFullProduct: firstProduct,
	});

	const customPrices = productContexts.flatMap(
		(productContext) => productContext.customPrices,
	);
	const customEnts = productContexts.flatMap(
		(productContext) => productContext.customEnts,
	);

	const outgoingCusProductIds = productContexts
		.map((pc) => pc.currentCustomerProduct?.id)
		.filter((id): id is string => id != null);
	const { storedChargeLineItems, storedRefundLineItems } =
		await fetchStoredLineItemsForSubscriptionBilling({
			db: ctx.db,
			fullCustomer,
			processorSubscriptionId: subscriptionId,
			outgoingCusProductIds,
		});

	const customerLicenseBillingContext =
		await setupCustomerLicenseBillingContext({ ctx, fullCustomer });

	return {
		fullCustomer,
		fullProducts,
		productContexts,
		currency: resolveCustomerCurrency({
			customer: fullCustomer,
			org: ctx.org,
			requested: params.currency,
		}),
		featureQuantities: productContexts.flatMap(
			(productContext) => productContext.featureQuantities,
		),
		adjustableFeatureQuantities: (params.plans ?? []).flatMap(
			(plan) =>
				plan.feature_quantities
					?.filter((featureQuantity) => featureQuantity.adjustable === true)
					.map((featureQuantity) => featureQuantity.feature_id) ?? [],
		),
		invoiceMode,
		enablePlanImmediately: params.enable_plan_immediately ?? false,
		currentEpochMs,
		billingCycleAnchorMs,
		resetCycleAnchorMs,
		billingStartsAt,
		subscriptionBackdateStartMs,
		requestedProrationBehavior: params.billing_behavior,
		requestedBillingCycleAnchor: params.billing_cycle_anchor,
		// Multi-attach has no carry_over_balances param, so there is no reset
		// cycle to round the refund to — only the no-partial-refund flag applies.
		anchorResetRefund: setupAnchorResetRefund({
			billingCycleAnchor: params.billing_cycle_anchor,
			prorationBehavior: params.billing_behavior,
		}),
		customPrices,
		customEnts,
		trialContext,
		skipBillingChanges:
			params.no_billing_changes === true ||
			isRevertTrialContext({ trialContext }),
		isCustom: customPrices.length > 0 || customEnts.length > 0,
		checkoutMode: setupImmediateMultiProductCheckoutMode({
			redirectMode: params.redirect_mode,
			invoiceMode,
			fullProducts,
		}),
		billingVersion: BillingVersion.V2,
		actionSource: "multiAttach",
		successUrl:
			params.success_url ?? orgToReturnUrl({ org: ctx.org, env: ctx.env }),
		checkoutSessionParams: params.checkout_session_params,
		storedChargeLineItems,
		storedRefundLineItems,
		customerLicenseBillingContext,
	};
};
