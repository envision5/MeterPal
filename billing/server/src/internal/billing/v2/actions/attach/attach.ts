import {
	type AttachBillingContext,
	type AttachParamsV1,
	type BillingContextOverride,
	type BillingResult,
	CheckoutAction,
} from "@autumn/shared";
import { ms } from "@shared/utils/common/unixUtils";
import { checkoutSessionLock } from "@/external/redis/actions/checkoutSessionLock/checkoutSessionLock.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { computeAttachPlan } from "@/internal/billing/v2/actions/attach/compute/computeAttachPlan";
import { handleAttachComputeErrors } from "@/internal/billing/v2/actions/attach/errors/handleAttachComputeErrors";
import { handleAttachV2Errors } from "@/internal/billing/v2/actions/attach/errors/handleAttachV2Errors";
import { logAttachContext } from "@/internal/billing/v2/actions/attach/logs/logAttachContext";
import { setupAttachBillingContext } from "@/internal/billing/v2/actions/attach/setup/setupAttachBillingContext";
import { checkCheckoutSessionLock } from "@/internal/billing/v2/actions/locks/checkoutSessionLock/checkCheckoutSessionLock";
import { executeBillingPlan } from "@/internal/billing/v2/execute/executeBillingPlan";
import { executeAutumnBillingPlan } from "@/internal/billing/v2/execute/executeAutumnBillingPlan";
import { publishBillingTransition } from "@/internal/billing/v2/publish/publishBillingTransition.js";
import {
	type CreateAutumnCheckoutResult,
	createAutumnCheckout,
} from "../../common/createAutumnCheckout";
import { isPaypalConnected } from "@/internal/orgs/orgUtils.js";
import { runPaypalCheckout } from "@/internal/billing/paypal/runPaypalCheckout.js";
import { invalidateCachedFullSubject } from "@/internal/customers/cache/fullSubject/index.js";
import { hasActiveCustomerProductForProduct } from "@/internal/customers/cusProducts/hasActiveCustomerProductForProduct";
import { sendBillingUpdatedWebhook } from "@/internal/billing/v2/workflows/sendBillingUpdatedWebhook/sendBillingUpdatedWebhook";
import { billingPlanToSendProductsUpdated } from "@/internal/billing/v2/workflows/sendProductsUpdated/billingPlanToSendProductsUpdated";
import { computeAttachPreviewBillingPlan } from "@/internal/billing/v2/utils/billingPlan/preview/computeAttachPreviewBillingPlan";
import { resolveCarryOverUsagesParam } from "@/internal/billing/v2/utils/handleCarryOvers/resolveCarryOverUsagesParam";
import { logAutumnBillingPlan } from "@/internal/billing/v2/utils/logs/logAutumnBillingPlan";
import { preserveSubjectCache } from "@/internal/customers/cache/fullSubject/actions/preserveSubjectCache.js";
import { RecaseError, ErrCode } from "@autumn/shared";
import { hashJson } from "@/utils/hash/hashJson";

const LONG_LIVED_CHECKOUT_EXPIRY_MS = ms.days(90);

export async function attach({
	ctx,
	params,
	preview = false,
	skipAutumnCheckout = false,

	contextOverride,
}: {
	ctx: AutumnContext;
	params: AttachParamsV1;
	preview?: boolean;
	skipAutumnCheckout?: boolean;

	contextOverride?: BillingContextOverride;
}): Promise<CreateAutumnCheckoutResult<AttachBillingContext>> {
	const checkoutReservation =
		!preview && !skipAutumnCheckout
			? await checkoutSessionLock.get({
					ctx,
					customerId: params.customer_id,
				})
			: undefined;

	params = {
		...params,
		carry_over_usages: await resolveCarryOverUsagesParam({
			ctx,
			carryOverUsages: params.carry_over_usages,
		}),
	};

	// 1. Setup
	const billingContext = await setupAttachBillingContext({
		ctx,
		params,
		preview,
		contextOverride,
	});

	logAttachContext({ ctx, billingContext });

	// 2. Compute
	const autumnBillingPlan = computeAttachPlan({
		ctx,
		attachBillingContext: billingContext,
		params,
		hasFullCustomerOverride: Boolean(contextOverride?.fullCustomer),
	});

	logAutumnBillingPlan({ ctx, plan: autumnBillingPlan, billingContext });
	await handleAttachComputeErrors({
		ctx,
		billingContext,
		autumnBillingPlan,
		params,
	});

	const billingPlan = { autumn: autumnBillingPlan };

	// 3. Errors (requires full billing plan)
	await handleAttachV2Errors({
		ctx,
		billingContext,
		billingPlan,
		params,
		preview,
	});

	// 3b. PayPal-native orgs buying a paid product: the buyer approves on
	// PayPal, money lands via /webhooks/paypal, and the wallet is credited.
	// The approval URL rides the response's payment_url field.
	if (
		!preview &&
		billingContext.checkoutMode === "processor_checkout" &&
		!skipAutumnCheckout
	) {
		if (!isPaypalConnected({ org: ctx.org, env: ctx.env })) {
			throw new RecaseError({
				code: ErrCode.ProcessorConfigNotFound,
				message:
					"No PayPal connection for this org — connect PayPal in settings to sell paid plans",
				statusCode: 400,
			});
		}

		preserveSubjectCache({ ctx });
		const products = billingContext.attachProduct
			? [billingContext.attachProduct]
			: [];
		const checkoutUrl = await runPaypalCheckout({
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

		// No checkout URL means the customer ALREADY holds an active PayPal
		// subscription for this product: the buyer approved and PayPal already
		// charged, so there is nothing left to buy.  The money is paid, so
		// MeterPal still has to reflect the plan — apply the Autumn-side
		// attach (customer product + entitlements + allowance) right now.
		//
		// Returning "no checkout URL" without applying it leaves the customer
		// billed for a plan they never receive, and makes the UI's plan switch
		// a silent no-op that looks like it succeeded.
		if (!checkoutUrl) {
			// The plan may already be applied: the PayPal checkout can activate
			// an approved-but-pending subscription on the way through, and the
			// activation attaches the plan with it.  The billing context is a
			// snapshot from before that, so re-read the customer's products.
			const alreadyOnPlan = await hasActiveCustomerProductForProduct({
				db: ctx.db,
				internalCustomerId: billingContext.fullCustomer.internal_id,
				productId: billingContext.attachProduct?.id,
			});

			if (alreadyOnPlan) {
				// Already on this plan MeterPal-side — nothing to apply, and
				// nothing to pay for (the PayPal subscription is already paid).
				return {
					billingContext,
					billingPlan,
					billingResult: { processor: { deferred: false } },
				};
			}

			// The plan is applied right here, so the cached subject (and the
			// balances on it) are stale the moment this returns.  The PayPal
			// branch preserves the cache for the checkout flow — where nothing
			// is applied until the buyer approves — so undo that here and drop
			// the cache explicitly.  Without this the switch looks like it did
			// nothing: the API keeps serving the old plan and old balance.
			ctx.skipSubjectCacheDeletion = false;

			await executeAutumnBillingPlan({
				ctx,
				autumnBillingPlan,
			});

			await invalidateCachedFullSubject({
				ctx,
				customerId: billingContext.fullCustomer.id ?? ctx.customerId ?? "",
				source: "attach:paypal-already-subscribed",
			});

			await publishBillingTransition({
				ctx,
				billingContext,
				billingPlan,
				executionDeferred: false,
			});

			await billingPlanToSendProductsUpdated({
				ctx,
				autumnBillingPlan,
				billingContext,
			});

			void sendBillingUpdatedWebhook({
				ctx,
				autumnBillingPlan,
				originalFullCustomer: billingContext.fullCustomer,
			});

			return {
				billingContext,
				billingPlan,
				billingResult: { processor: { deferred: false } },
			};
		}

		// Early exit: execution intentionally skipped — the
		// billingResultToResponse mapper only needs the checkout URL.
		return {
			billingContext,
			billingPlan: undefined,
			billingResult: {
				processor: {
					deferred: true,
					checkoutId: `paypal-${crypto.randomUUID()}`,
					checkoutUrl,
				},
			},
		} as unknown as {
			billingContext: typeof billingContext;
			billingPlan: typeof billingPlan;
			billingResult: BillingResult;
		};
	}

	if (preview) {
		const previewBillingPlan = await computeAttachPreviewBillingPlan({
			ctx,
			billingContext,
			autumnBillingPlan,
		});

		return {
			billingContext,
			billingPlan: { ...billingPlan, preview: previewBillingPlan },
		};
	}

	const shouldCreateLongLivedCheckout =
		params.long_lived_checkout && !skipAutumnCheckout;

	const autumnCheckoutParams = params.long_lived_checkout
		? { ...params, long_lived_checkout: false }
		: params;

	const arbitrateCheckoutLock = () =>
		checkCheckoutSessionLock({
			ctx,
			params: autumnCheckoutParams,
			billingContext,
			billingPlan,
			existingLock: checkoutReservation,
		});

	// 4. Checkout session lock (skip for confirm flows)
	if (!skipAutumnCheckout && !shouldCreateLongLivedCheckout) {
		const cachedResult = await arbitrateCheckoutLock();
		if (cachedResult) {
			preserveSubjectCache({ ctx });
			return cachedResult;
		}
	}

	if (shouldCreateLongLivedCheckout) {
		// Creating a checkout changes no Autumn balance state. Keep any accepted
		// Redis-only tracks for the later confirmation request to consume.
		preserveSubjectCache({ ctx });
		return createAutumnCheckout<AttachBillingContext>({
			ctx,
			action: CheckoutAction.Attach,
			params,
			billingContext,
			billingPlan,
			expiresInMs: LONG_LIVED_CHECKOUT_EXPIRY_MS,
		});
	}

	if (
		billingContext.checkoutMode === "autumn_checkout" &&
		!skipAutumnCheckout
	) {
		preserveSubjectCache({ ctx });
		return createAutumnCheckout<AttachBillingContext>({
			ctx,
			action: CheckoutAction.Attach,
			params: autumnCheckoutParams,
			billingContext,
			billingPlan,
		});
	}

	// 5. Execute billing plan (DB-only — PayPal checkouts returned above)
	const billingResult = await executeBillingPlan({
		ctx,
		billingContext,
		billingPlan,
		checkoutLockParamsHash: !skipAutumnCheckout
			? hashJson({ value: autumnCheckoutParams })
			: undefined,
	});
	if (billingResult.processor?.deferred) {
		preserveSubjectCache({ ctx });
	}

	// 6. Publish the compute-time balance transition
	await publishBillingTransition({
		ctx,
		billingContext,
		billingPlan,
		executionDeferred: billingResult.processor?.deferred === true,
	});

	return {
		billingContext,
		billingPlan,
		billingResult,
	};
}
