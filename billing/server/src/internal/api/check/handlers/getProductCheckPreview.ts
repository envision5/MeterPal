import {
	addToExpand,
	type AttachParamsV1,
	AttachScenario,
	type CheckProductPreview,
	type Feature,
	type FullCusProduct,
	type FullCustomer,
	type FullProduct,
	formatAmount,
	type Organization,
} from "@autumn/shared";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import { getOptions } from "@/internal/api/check/checkUtils.js";
import { isAttachUpgrade } from "@/internal/billing/v2/actions/attach/utils/isAttachUpgrade";
import { billingActions } from "@/internal/billing/v2/actions";
import { billingPlanToAttachPreview } from "@/internal/billing/v2/utils/billingPlan/billingPlanToAttachPreview";
import { mapToProductItems } from "@/internal/products/productV2Utils.js";
import { getProductResponse } from "@/internal/products/productUtils/productResponseUtils/getProductResponse.js";
import { isFreeProduct, isOneOff } from "@/internal/products/productUtils.js";
import { notNullish } from "@/utils/genUtils.js";
import type { AutumnContext } from "../../../../honoUtils/HonoEnv.js";

/**
 * The engine preview no longer carries the legacy attach branch, so the
 * scenario is derived from the transition the attach would perform.
 */
const getAttachScenario = ({
	currentCustomerProduct,
	attachProduct,
	product,
}: {
	currentCustomerProduct?: FullCusProduct;
	attachProduct: FullProduct;
	product: FullProduct;
}): AttachScenario => {
	if (!currentCustomerProduct) {
		return AttachScenario.New;
	}

	if (isFreeProduct(product.prices)) {
		return AttachScenario.Cancel;
	}

	return isAttachUpgrade({
		currentCustomerProduct,
		attachProduct,
	})
		? AttachScenario.Upgrade
		: AttachScenario.Downgrade;
};

const attachToCheckPreview = async ({
	preview,
	product,
	org,
	features,
	db,
	fullCus,
	scenario,
	currentProductName,
}: {
	preview: Awaited<
		ReturnType<typeof billingPlanToAttachPreview>
	>;
	product: FullProduct;
	org: Organization;
	features: Feature[];
	db: DrizzleCli;
	fullCus: FullCustomer;
	scenario: AttachScenario;
	currentProductName?: string;
}) => {
	const items = preview.line_items?.map((item) => {
		return {
			price: notNullish(item.total)
				? formatAmount({
						amount: item.total,
						org,
						minFractionDigits: 2,
						maxFractionDigits: 2,
					})
				: item.description,
			description: item.description,
		};
	});

	const options = getOptions({
		prodItems: mapToProductItems({
			prices: product.prices,
			entitlements: product.entitlements,
			features,
		}),
		features,
	}) as CheckProductPreview["options"];

	const due_today = {
		price: preview.total,
		currency: preview.currency || org.default_currency || "usd",
	};

	const due_next_cycle = preview.next_cycle
		? {
				price: preview.next_cycle.total,
				currency: preview.currency || org.default_currency || "usd",
			}
		: undefined;

	const checkPreview: CheckProductPreview = {
		scenario,

		// Meta
		product_id: product.id,
		product_name: product.name,
		recurring: !isOneOff(product.prices),
		error_on_attach: false,
		next_cycle_at: preview.next_cycle?.starts_at,
		current_product_name: currentProductName,

		// Otehrs
		options: options && options.length > 0 ? options : undefined,
		items: items && items.length > 0 ? items : undefined,
		due_today,
		due_next_cycle,
		product: await getProductResponse({
			product,
			features,
			db,
			fullCus,
			currency: org.default_currency || undefined,
		}),
	};
	return checkPreview;
};

export const getProductCheckPreview = async ({
	ctx,
	customer,
	product,
}: {
	ctx: AutumnContext;
	customer: FullCustomer;
	product: FullProduct;
}) => {
	const { org, features, db } = ctx;

	// Build attach params
	const attachParams: AttachParamsV1 = {
		customer_id: customer.id!,
		plan_id: product.id,
		redirect_mode: "if_required",
		...(customer.entity?.id ? { entity_id: customer.entity.id } : {}),
	};

	const { billingContext, billingPlan } = await billingActions.attach({
		ctx,
		params: attachParams,
		preview: true,
	});

	if (!billingPlan) {
		throw new Error("Billing plan not found for check preview");
	}

	const preview = await billingPlanToAttachPreview({
		ctx: addToExpand({
			ctx,
			add: ["incoming.plan.items.feature", "outgoing.plan.items.feature"],
		}),
		billingContext,
		billingPlan,
	});

	const scenario = getAttachScenario({
		currentCustomerProduct: billingContext.currentCustomerProduct,
		attachProduct: billingContext.attachProduct,
		product,
	});

	const checkPreview = await attachToCheckPreview({
		preview,
		product,
		org,
		features,
		db,
		fullCus: customer,
		scenario,
		currentProductName:
			billingContext.currentCustomerProduct?.product?.name ?? undefined,
	});

	return checkPreview;
};
