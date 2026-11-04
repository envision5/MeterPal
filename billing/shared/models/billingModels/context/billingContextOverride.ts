import type { BillingVersion } from "@models/billingModels/context/billingContext";
import type { PaymentBehaviorIntent } from "@models/billingModels/context/paymentBehaviorIntent";
import type { TransitionConfig } from "@models/billingModels/context/transitionConfig";
import type { InsertPlanLicenseSpec } from "@models/billingModels/plan/customerLicensePlan";
import type { FullCustomer } from "@models/cusModels/fullCusModel";
import type {
	FeatureOptions,
	FullCusProduct,
} from "@models/cusProductModels/cusProductModels";
import type { ProcessorType } from "@models/genModels/genEnums";
import type { Entitlement } from "@models/productModels/entModels/entModels";
import type { Price } from "@models/productModels/priceModels/priceModels";
import type { FullProduct } from "@models/productModels/productModels";

export interface BillingContextOverride {
	fullCustomer?: FullCustomer;

	productContext?: {
		fullProduct: FullProduct;
		customerProduct?: FullCusProduct;
		customPrices?: Price[];
		customEnts?: Entitlement[];
		insertPlanLicenses?: InsertPlanLicenseSpec[];
	};

	featureQuantities?: FeatureOptions[];
	transitionConfig?: TransitionConfig;
	billingVersion?: BillingVersion;
	endOfCycleMsOverride?: number;

	paymentBehaviorIntent?: PaymentBehaviorIntent;
	shouldFinalizeFirstInvoice?: boolean;

	/**
	 * Skips the custom payment method guard that normally blocks attach for
	 * customers managed by an external billing platform. Internal callers that
	 * ARE the origin platform set this to opt out of the guard. Not exposed via
	 * any public API schema.
	 */
	skipCustomPaymentMethodGuard?: boolean;

	/**
	 * Skips fetching processor state during attach setup, for callers whose
	 * customers have no processor presence (e.g. DB-only free plans).
	 * Independent from `params.no_billing_changes`, which only blocks writes.
	 */
	skipBillingFetching?: boolean;

	/**
	 * Skips the external-processor guard and the "paid current product but no
	 * subscription linked" guard. Used by callers that ARE the external origin
	 * platform and so must be allowed to attach onto their own existing
	 * cus_products. Not exposed via any public API schema.
	 */
	skipExternalPSPGuard?: boolean;

	/**
	 * Tags the newly-inserted customer_product's processor type. Defaults to
	 * leaving the processor unset.
	 */
	processorTypeOverride?: ProcessorType;
}

export interface UpdateSubscriptionBillingContextOverride
	extends BillingContextOverride {
	productContext?: {
		fullProduct: FullProduct;
		customerProduct: FullCusProduct;
		customPrices?: Price[];
		customEnts?: Entitlement[];
	};

	/** Build the context against this customer instead of fetching from DB.
	 * For fold-style callers (multiUpdate) whose customer carries prior updates. */
	projectedFullCustomer?: FullCustomer;

	/**
	 * When true, `buildAutumnLineItems` is called with
	 * `includeArrearLineItems: true` — existing consumable overage on the
	 * outgoing customer_product is invoiced as part of this update. Default
	 * (`updateSubscription`) skips arrear line items; `attach` includes them.
	 */
	chargeExistingOverages?: boolean;

	/**
	 * When true, the new customer_product is initialized WITHOUT carrying
	 * existing consumable usages from the outgoing customer_product (balances
	 * reset to the canonical starting balance from `getStartingBalance`).
	 * Default behavior carries all consumable usages forward. Pair with
	 * `chargeExistingOverages: true` to invoice the prior overage AND start
	 * the new cycle fresh.
	 */
	skipExistingUsageCarry?: boolean;

	/**
	 * Override the auto-computed `is_custom` flag on the new customer_product
	 * (default derives from `hasCustomItems(params.customize)`). Pass `false`
	 * to force the new cusProduct to be marked as a canonical (non-custom)
	 * instance even when the customize plan would otherwise look custom.
	 */
	forceIsCustom?: boolean;
}
