import { AttachFunction, type CheckoutParamsV0 } from "@autumn/shared";
import type { AutumnContext } from "../../../honoUtils/HonoEnv";
import { isPaypalConnected, isStripeConnected } from "../../orgs/orgUtils";
import { runPaypalCheckout } from "../paypal/runPaypalCheckout";
import { handleCreateCheckout } from "../../customers/add-product/handleCreateCheckout";
import { handleCreateInvoiceCheckout } from "../../customers/add-product/handleCreateInvoiceCheckout";
import {
	checkStripeConnections,
	handlePrepaidErrors,
} from "../../customers/attach/attachRouter";
import { handleCheckoutErrors } from "../../customers/attach/attachUtils/handleAttachErrors/handleCheckoutErrors";
import { insertCustomItems } from "../../customers/attach/attachUtils/insertCustomItems";
import { attachParamsToPreview } from "../attachPreview/attachParamsToPreview";
import { getHasProrations } from "./getHasProrations";
import { previewToCheckoutRes } from "./previewToCheckoutRes";
import { checkoutToAttachContext } from "./utils/checkoutToAttachContext";
import { getCheckoutOptions } from "./utils/getCheckoutOptions";

/**
 * Core checkout flow, shared by the public `/v1/checkout` route and internal
 * callers that run checkout against a context they build themselves (e.g. the
 * pricing agent's preview sandbox org).
 */
export const runCheckout = async ({
	ctx,
	checkoutParams,
}: {
	ctx: AutumnContext;
	checkoutParams: CheckoutParamsV0;
}) => {
	const { attachParams, branch, func, config, customPrices, customEnts } =
		await checkoutToAttachContext({
			ctx,
			checkoutParams,
		});

	let checkoutUrl = null;

	handleCheckoutErrors({
		attachParams,
		branch,
	});

	if (func === AttachFunction.CreateCheckout) {
		await insertCustomItems({
			db: ctx.db,
			customPrices: customPrices || [],
			customEnts: customEnts || [],
		});

		await handlePrepaidErrors({
			attachParams,
			config,
			useCheckout: config.onlyCheckout,
		});

		if (
		isPaypalConnected({ org: ctx.org, env: ctx.env }) &&
		!isStripeConnected({ org: ctx.org, env: ctx.env })
	) {
			// PayPal-native path: returns the buyer-approval URL (Orders v2 for
			// one-off credit packs, Subscriptions for recurring plans).  Money-in
			// lands via /webhooks/paypal, which grants wallet credits.
			checkoutUrl = await runPaypalCheckout({
				attachParams,
				db: ctx.db,
				env: ctx.env,
			});
		} else {
			await checkStripeConnections({
				ctx,
				attachParams,
				createCus: true,
				useCheckout: true,
			});

			if (config.invoiceCheckout) {
				const result = await handleCreateInvoiceCheckout({
					ctx,
					attachParams,
					config,
					branch,
				});

				checkoutUrl = result?.checkout_url;
			} else {
				const result = await handleCreateCheckout({
					ctx,
					attachParams,
					config,
					returnCheckout: true,
				});

				checkoutUrl = result?.checkout_url;
			}
		}
	}

	await getCheckoutOptions({
		ctx,
		attachParams,
	});

	const preview = await attachParamsToPreview({
		ctx,
		attachParams,
		attachBody: checkoutParams,
		withPrepaid: true,
	});

	const checkoutRes = await previewToCheckoutRes({
		ctx,
		attachParams,
		preview,
		branch,
	});

	const hasProrations = await getHasProrations({
		branch,
		attachParams,
	});

	return {
		...checkoutRes,
		url: checkoutUrl,
		has_prorations: hasProrations,
	};
};
