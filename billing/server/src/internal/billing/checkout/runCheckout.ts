import {
	type AttachParamsV1,
	type CheckoutParamsV0,
	type CheckoutResponseV0,
	type FullProduct,
} from "@autumn/shared";
import type { AutumnContext } from "../../../honoUtils/HonoEnv";
import { isPaypalConnected } from "../../orgs/orgUtils";
import { runPaypalCheckout } from "../paypal/runPaypalCheckout";
import { RecaseError, ErrCode } from "@autumn/shared";
import { computeAttachPlan } from "../v2/actions/attach/compute/computeAttachPlan";
import { setupAttachBillingContext } from "../v2/actions/attach/setup/setupAttachBillingContext";
import { computeAttachPreviewBillingPlan } from "../v2/utils/billingPlan/preview/computeAttachPreviewBillingPlan";
import { logAutumnBillingPlan } from "../v2/utils/logs/logAutumnBillingPlan";
import { getProductResponse } from "../../products/productUtils/productResponseUtils/getProductResponse";
import { resolveCarryOverUsagesParam } from "../v2/utils/handleCarryOvers/resolveCarryOverUsagesParam";

/**
 * Core checkout flow for the public `/v1/checkout` route: builds the v2
 * billing context + plan, previews the charges, and — for paid products on a
 * PayPal-connected org — returns the PayPal buyer-approval URL. Money-in
 * lands via /webhooks/paypal, which grants wallet credits.
 */
export const runCheckout = async ({
	ctx,
	checkoutParams,
}: {
	ctx: AutumnContext;
	checkoutParams: CheckoutParamsV0;
}) => {
	const params = {
		...checkoutParams,
		carry_over_usages: await resolveCarryOverUsagesParam({
			ctx,
		}),
	} as AttachParamsV1;

	// 1. Setup + compute (same pipeline as attach)
	const billingContext = await setupAttachBillingContext({
		ctx,
		params,
		preview: true,
	});

	const autumnBillingPlan = computeAttachPlan({
		ctx,
		attachBillingContext: billingContext,
		params,
	});

	logAutumnBillingPlan({ ctx, plan: autumnBillingPlan, billingContext });

	const preview = await computeAttachPreviewBillingPlan({
		ctx,
		billingContext,
		autumnBillingPlan,
	});

	// 2. PayPal approval URL for paid products
	let checkoutUrl: string | null = null;
	if (billingContext.checkoutMode === "processor_checkout") {
		if (!isPaypalConnected({ org: ctx.org, env: ctx.env })) {
			throw new RecaseError({
				code: ErrCode.ProcessorConfigNotFound,
				message:
					"No PayPal connection for this org — connect PayPal in settings to sell paid plans",
				statusCode: 400,
			});
		}

		const products = billingContext.attachProduct
			? [billingContext.attachProduct]
			: [];
		checkoutUrl = await runPaypalCheckout({
			attachParams: {
				org: ctx.org,
				customer: billingContext.fullCustomer,
				products,
				prices: products.flatMap((p) => p.prices),
				successUrl: params.success_url,
			},
			db: ctx.db,
			env: ctx.env,
		});
	}

	// 3. Build the checkout response
	const { fullCustomer, features, org } = billingContext
		? { fullCustomer: billingContext.fullCustomer, features: ctx.features, org: ctx.org }
		: ({} as never);

	const chargeLineItems = (autumnBillingPlan.lineItems ?? []).filter(
		(li) => li.context.direction === "charge",
	);

	const lines = chargeLineItems.map((li) => ({
		description: li.description,
		amount: li.amountAfterDiscounts ?? li.amount,
		item: null,
	}));

	const total = lines.reduce((acc, line) => acc + line.amount, 0);

	const currentCustomerProduct = billingContext.currentCustomerProduct;
	const currentProduct = currentCustomerProduct
		? await getProductResponse({
				product: {
					...currentCustomerProduct.product,
					prices: currentCustomerProduct.customer_prices.map(
						(customerPrice) => customerPrice.price,
					),
					entitlements: currentCustomerProduct.customer_entitlements.map(
						(customerEntitlement) => customerEntitlement.entitlement,
					),
				} as FullProduct,
				features,
				currency: org.default_currency || "usd",
				options: currentCustomerProduct.options,
			})
		: null;

	const newProduct = billingContext.attachProduct
		? await getProductResponse({
				product: billingContext.attachProduct,
				features,
				currency: org.default_currency || "usd",
				options: billingContext.featureQuantities,
				fullCus: fullCustomer,
			})
		: null;

	const response: CheckoutResponseV0 = {
		url: checkoutUrl,
		customer_id: fullCustomer.id || fullCustomer.internal_id,
		lines,
		product: newProduct,
		current_product: currentProduct,
		options: billingContext.featureQuantities,
		total,
		currency: org.default_currency || "usd",
		has_prorations: chargeLineItems.some((li) => li.prorated ?? false),
		next_cycle: null,
	};

	return response;
};
