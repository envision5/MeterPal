import type { CustomerLicenseTransition } from "@autumn/shared";
import { formatMs } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { addToExtraLogs } from "@/utils/logging/addToExtraLogs";
import type { ProductTransitions } from "./compute/transitions/computeProductTransitions";
import type { BasePriceOperationResult } from "./execute/executeBasePriceOperation";
import type { BatchTransitionContext, CustomerEntitlementBatchTransition } from "./types/types";

/** Logs the customer/product state a batch transition runs against. */
export const logBatchTransitionContext = ({
	ctx,
	batchTransitionContext,
}: {
	ctx: AutumnContext;
	batchTransitionContext: BatchTransitionContext;
}) => {
	const { fullCustomer, parentCustomerProduct, currentEpochMs, resetCycleAnchorMs } =
		batchTransitionContext;

	addToExtraLogs({
		ctx,
		extras: {
			batchTransitionContext: {
				customer: fullCustomer.id,
				parentCustomerProduct: `${parentCustomerProduct.id} (${parentCustomerProduct.product?.id ?? "unknown"})`,
				timestamps: `Current: ${formatMs(currentEpochMs)} | Reset: ${resetCycleAnchorMs === "now" ? "now" : formatMs(resetCycleAnchorMs)}`,
			},
		},
	});
};

/** Logs the product-level transitions a batch transition will apply. */
export const logBatchTransitionProductTransitions = ({
	ctx,
	transition,
	productTransitions,
}: {
	ctx: AutumnContext;
	transition: CustomerLicenseTransition;
	productTransitions: ProductTransitions;
}) => {
	const { entitlementPrices, basePrice, customerProduct } = productTransitions;

	addToExtraLogs({
		ctx,
		extras: {
			batchTransitionProductTransitions: {
				fromProduct:
					transition.outgoingCustomerLicense.planLicense?.product?.id ??
					"unknown",
				toProduct:
					transition.incomingCustomerLicense.planLicense?.product?.id ??
					"unknown",
				basePrice: basePrice
					? `${basePrice.type} (${basePrice.fromPrice?.id ?? "none"} -> ${basePrice.toPrice?.id ?? "none"})`
					: "none",
				customerProduct: customerProduct
					? `${customerProduct.fromInternalProductId} -> ${customerProduct.toInternalProductId}`
					: "none",
				entitlementPrices: {
					transitions: entitlementPrices.transitions.length,
					retained: entitlementPrices.retained.length,
					added: entitlementPrices.added.length,
					deleted: entitlementPrices.deleted.length,
				},
			},
		},
	});
};

/** Logs the operations a batch transition resolved to. */
export const logBatchTransitionOperations = ({
	ctx,
	batchTransition,
}: {
	ctx: AutumnContext;
	batchTransition: CustomerEntitlementBatchTransition;
}) => {
	const { operations, unhandledTransitions, customerLicenseLinkId } =
		batchTransition;

	addToExtraLogs({
		ctx,
		extras: {
			batchTransitionOperations: {
				customerLicenseLinkId,
				basePrice: operations.basePrice
					? operations.basePrice.type
					: "none",
				customerEntitlementCycles: operations.customerEntitlementCycles.length,
				entitlementPrices: operations.entitlementPrices.length,
				unhandledTransitions: unhandledTransitions.length,
			},
		},
	});
};

/** Logs the outcome of a batch transition. */
export const logBatchTransitionResult = ({
	ctx,
	customerLicenseLinkId,
	result,
}: {
	ctx: AutumnContext;
	customerLicenseLinkId: string;
	result: {
		customerEntitlements: { replaced: number; added: number; removed: number };
		customerEntitlementCyclesAligned: number;
		basePrices: BasePriceOperationResult;
		customerProductsUpdated: number;
	};
}) => {
	addToExtraLogs({
		ctx,
		extras: {
			batchTransitionResult: {
				customerLicenseLinkId,
				customerEntitlements: `replaced ${result.customerEntitlements.replaced} | added ${result.customerEntitlements.added} | removed ${result.customerEntitlements.removed}`,
				customerEntitlementCyclesAligned:
					result.customerEntitlementCyclesAligned,
				basePrices: `replaced ${result.basePrices.replaced} | added ${result.basePrices.added} | removed ${result.basePrices.removed}`,
				customerProductsUpdated: result.customerProductsUpdated,
			},
		},
	});
};
