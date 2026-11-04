import type { CustomerData } from "@autumn/shared";
import {
	ApiVersion,
	type CustomerBillingControlsParams,
	type OrgConfig,
	type PlanLicenseParams,
	type PlanTiming,
	type ProductItem,
	type ProductV2,
} from "@autumn/shared";
import { resetAndGetCusEnt } from "@tests/balances/track/rollovers/rolloverTestUtils.js";
import { warmEntityCaches as warmEntityCachesFn } from "@tests/integration/balances/utils/warmEntityCaches.js";
import { addDays, addHours, addMonths } from "date-fns";
import { AutumnInt } from "@/external/autumn/autumnCli.js";
import { CusService } from "@/internal/customers/CusService.js";
import { generateId } from "@/utils/genUtils.js";
import { hoursToFinalizeInvoice } from "../constants.js";
import { advanceBillingCycle } from "./advanceBillingCycle.js";
import { createSubOrgTestContext } from "./createSubOrgTestContext.js";
import defaultCtx, { type TestContext } from "./createTestContext.js";
import { initTestCustomer } from "./initTestCustomer.js";
import { initTestProducts } from "./initTestProducts.js";

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

type FeatureOption = {
	feature_id: string;
	quantity: number;
};

type LicenseQuantityOption = {
	licenseProductId: string;
	quantity: number;
};

type EntityConfig = {
	count: number;
	featureId: string;
	defaultGroup?: string;
};

type GeneratedEntity = {
	id: string;
	name: string;
	featureId: string;
};

type GeneratedLicenseAssignment = {
	id: string;
	entity_id: string;
	license_plan_id: string;
	started_at: number;
	ended_at: number | null;
};

type OtherCustomerConfig = {
	id: string;
	/** Accepted for call-site compatibility; the PayPal processor has no card payment methods. */
	paymentMethod?: "success" | "fail" | "authenticate" | "alipay";
	data?: CustomerData;
};

// Discriminated union for all action types
type AttachAction = {
	type: "attach";
	productId: string;
	customerId?: string; // Override: use this customer instead of primary
	entityIndex?: number;
	options?: FeatureOption[];
	newBillingSubscription?: boolean;
	timeout?: number;
};

type CancelAction = {
	type: "cancel";
	productId: string;
	entityIndex?: number;
};

type AdvanceClockAction = {
	type: "advanceClock";
	days?: number;
	weeks?: number;
	hours?: number;
	months?: number;
	toNextInvoice?: boolean;
	waitForSeconds?: number;
};

type TrackAction = {
	type: "track";
	featureId: string;
	value: number;
	properties?: Record<string, unknown>;
	entityIndex?: number;
	timeout?: number;
};

type UpdateSubscriptionAction = {
	type: "updateSubscription";
	productId: string;
	entityIndex?: number;
	cancelAction?: "cancel_end_of_cycle" | "cancel_immediately" | "uncancel";
	items?: ProductItem[];
};

type AdvanceToNextInvoiceAction = {
	type: "advanceToNextInvoice";
	withPause?: boolean;
};

type BillingAttachAction = {
	type: "billingAttach";
	productId: string;
	customerId?: string; // Override: use this customer instead of primary
	entityIndex?: number;
	options?: FeatureOption[];
	licenseQuantities?: LicenseQuantityOption[];
	newBillingSubscription?: boolean;
	planSchedule?: PlanTiming;
	timeout?: number;
	items?: ProductItem[]; // Custom product items (creates is_custom product)
	subscriptionId?: string;
	invoice?: boolean;
	enableProductImmediately?: boolean;
	finalizeInvoice?: boolean;
	billingControls?: CustomerBillingControlsParams;
};

type MultiAttachPlan = {
	productId: string;
	featureQuantities?: FeatureOption[];
	version?: number;
};

type BillingMultiAttachAction = {
	type: "billingMultiAttach";
	plans: MultiAttachPlan[];
	entityIndex?: number;
	freeTrial?: { length: number; duration: string; card_required?: boolean };
	timeout?: number;
};

type LinkLicenseAction = {
	type: "linkLicense";
	parentProductId: string;
	licenseProductId: string;
	included: number;
	prepaidOnly?: boolean;
	customize?: PlanLicenseParams["customize"];
	metadata?: Record<string, unknown>;
};

type AssignLicenseAction = {
	type: "assignLicense";
	licenseProductId: string;
	entityIndex?: number;
	entityIndexes?: number[];
	parentProductId?: string;
};

type ResetFeatureAction = {
	type: "resetFeature";
	featureId: string;
	timeout?: number;
};

type ParallelAction = {
	type: "parallel";
	actions: ScenarioAction[];
};

type ScenarioAction =
	| AttachAction
	| { type: "warmEntityCaches" }
	| CancelAction
	| AdvanceClockAction
	| TrackAction
	| UpdateSubscriptionAction
	| AdvanceToNextInvoiceAction
	| BillingAttachAction
	| BillingMultiAttachAction
	| LinkLicenseAction
	| AssignLicenseAction
	| ResetFeatureAction
	| ParallelAction;

type CleanupConfig = {
	customerIdsToDelete: string[];
	emailsToDelete: string[];
};

type PlatformCreateConfig = {
	slug?: string;
	name?: string;
	userEmail?: string;
	configOverrides?: Partial<OrgConfig>;
	setupDefaultFeatures?: boolean;
};

type ScenarioConfig = {
	/**
	 * Retained for call-site compatibility. The PayPal processor has no
	 * processor-side test clock, so there is nothing to switch off.
	 */
	testClock: boolean;
	customerData?: CustomerData;
	withDefault: boolean;
	defaultGroup?: string;
	skipWebhooks?: boolean;
	sendEmailReceipts?: boolean;
	nameOverride?: string | null;
	emailOverride?: string | null;
	products: ProductV2[];
	productPrefix?: string;
	entityConfig?: EntityConfig;
	customerIds?: string[];
	cleanup: CleanupConfig;
	actions: ScenarioAction[];
	otherCustomers: OtherCustomerConfig[];
	platformConfig?: PlatformCreateConfig;
};

type ConfigFn = (config: ScenarioConfig) => ScenarioConfig;

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/** Builds entities with ids "ent-1", "ent-2", etc. */
const generateEntities = (config: EntityConfig): GeneratedEntity[] => {
	return Array.from({ length: config.count }, (_, i) => ({
		id: `ent-${i + 1}`,
		name: `Entity ${i + 1}`,
		featureId: config.featureId,
	}));
};

// ═══════════════════════════════════════════════════════════════════
// SCENARIO CONFIG FUNCTIONS (s.*)
// ═══════════════════════════════════════════════════════════════════

/**
 * Shift a date forward by the requested amount of days/weeks/hours/months.
 * Mirrors the offsets the old processor test clock accepted.
 */
const addBillingDelta = ({
	startingFrom,
	days,
	weeks,
	hours,
	months,
}: {
	startingFrom: Date;
	days?: number;
	weeks?: number;
	hours?: number;
	months?: number;
}): Date => {
	let result = startingFrom;
	if (months) {
		result = addMonths(result, months);
	}
	if (weeks) {
		result = addDays(result, weeks * 7);
	}
	if (days) {
		result = addDays(result, days);
	}
	if (hours) {
		result = addHours(result, hours);
	}
	return result;
};

/**
 * Configure customer options: payment method, data, default product.
 * Pass `name: null` / `email: null` for a nameless / emailless customer.
 * `paymentMethod` is accepted for call-site compatibility only: the PayPal
 * processor has no card payment methods, so nothing is attached.
 * @example s.customer({ paymentMethod: "success" })
 * @example s.customer({ withDefault: true, defaultGroup: "enterprise" })
 */
const customer = ({
	testClock = true,
	data,
	withDefault,
	defaultGroup,
	skipWebhooks,
	send_email_receipts,
	name,
	email,
}: {
	testClock?: boolean;
	paymentMethod?: "success" | "fail" | "authenticate" | "alipay";
	data?: CustomerData;
	withDefault?: boolean;
	defaultGroup?: string;
	skipWebhooks?: boolean;
	send_email_receipts?: boolean;
	name?: string | null;
	email?: string | null;
} = {}): ConfigFn => {
	return (config) => ({
		...config,
		testClock,
		customerData: data ?? config.customerData,
		withDefault: withDefault ?? config.withDefault,
		defaultGroup: defaultGroup ?? config.defaultGroup,
		skipWebhooks: skipWebhooks ?? config.skipWebhooks,
		sendEmailReceipts: send_email_receipts ?? config.sendEmailReceipts,
		nameOverride: name,
		emailOverride: email,
	});
};

/**
 * Products for this scenario. Auto-prefixed with customerId for isolation.
 * @example s.products({ list: [pro, free] })
 * @example s.products({ list: [freeDefault], prefix: "my-prefix" })
 */
const products = ({
	list,
	prefix,
	customerIdsToDelete,
}: {
	list: ProductV2[];
	prefix?: string;
	customerIdsToDelete?: string[];
}): ConfigFn => {
	return (config) => ({
		...config,
		products: list,
		productPrefix: prefix,
		customerIds: customerIdsToDelete,
	});
};

/**
 * Auto-generates entities with ids "ent-1", "ent-2", etc.
 * @example s.entities({ count: 2, featureId: TestFeature.Users })
 */
const entities = ({
	count,
	featureId,
	defaultGroup,
}: {
	count: number;
	featureId: string;
	defaultGroup?: string;
}): ConfigFn => {
	return (config) => ({
		...config,
		entityConfig: { count, featureId, defaultGroup },
	});
};

/**
 * Define additional customers for this test scenario.
 * Useful for scenarios that need more than one customer.
 * @example s.otherCustomers([{ id: "other" }])
 */
const otherCustomers = (customers: OtherCustomerConfig[]): ConfigFn => {
	return (config) => ({ ...config, otherCustomers: customers });
};

/**
 * Attach a product to the customer or an entity. Product ID auto-prefixed.
 * @example s.attach({ productId: "pro" })
 * @example s.attach({ productId: "pro", entityIndex: 0 })
 * @example s.attach({ productId: "pro", options: [{ feature_id: "messages", quantity: 100 }] })
 */
const attach = ({
	productId,
	customerId,
	entityIndex,
	options,
	newBillingSubscription,
	timeout,
}: {
	productId: string;
	customerId?: string;
	entityIndex?: number;
	options?: FeatureOption[];
	newBillingSubscription?: boolean;
	timeout?: number;
}): ConfigFn => {
	const concurrency = Number(process.env.TEST_FILE_CONCURRENCY || "0");
	const defaultTimeout = concurrency > 1 ? 8000 : 4000;
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "attach" as const,
				productId,
				customerId,
				entityIndex,
				options,
				newBillingSubscription,
				timeout: timeout ?? defaultTimeout,
			},
		],
	});
};

/**
 * Cancel a product subscription for the customer or an entity.
 * @example s.cancel({ productId: "pro" })
 * @example s.cancel({ productId: "pro", entityIndex: 0 })
 */
const cancel = ({
	productId,
	entityIndex,
}: {
	productId: string;
	entityIndex?: number;
}): ConfigFn => {
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{ type: "cancel" as const, productId, entityIndex },
		],
	});
};

/**
 * Advance the customer's billing cycle. Successive calls chain from the previous endpoint.
 * @example s.advanceTestClock({ days: 15 })
 * @example s.advanceTestClock({ toNextInvoice: true })
 * @example s.advanceTestClock({ days: 8, waitForSeconds: 30 })
 */
const advanceTestClock = ({
	days,
	weeks,
	hours,
	months,
	toNextInvoice,
	waitForSeconds,
}: {
	days?: number;
	weeks?: number;
	hours?: number;
	months?: number;
	toNextInvoice?: boolean;
	waitForSeconds?: number;
}): ConfigFn => {
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "advanceClock" as const,
				days,
				weeks,
				hours,
				months,
				toNextInvoice,
				waitForSeconds,
			},
		],
	});
};

const warmEntityCaches = (): ConfigFn => (config) => ({
	...config,
	actions: [...config.actions, { type: "warmEntityCaches" }],
});

/**
 * Track feature usage for the customer or an entity.
 * @example s.track({ featureId: TestFeature.Messages, value: 300 })
 * @example s.track({ featureId: TestFeature.Messages, value: 250, entityIndex: 0 })
 */
const track = ({
	featureId,
	value,
	properties,
	entityIndex,
	timeout,
}: {
	featureId: string;
	value: number;
	properties?: Record<string, unknown>;
	entityIndex?: number;
	timeout?: number;
}): ConfigFn => {
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "track" as const,
				featureId,
				value,
				properties,
				entityIndex,
				timeout,
			},
		],
	});
};

/**
 * Update a subscription (cancel end-of-cycle, add items, etc.).
 * @example s.updateSubscription({ productId: "pro", cancelAction: "cancel_end_of_cycle" })
 * @example s.updateSubscription({ productId: "pro", items: [consumableItem] })
 */
const updateSubscription = ({
	productId,
	entityIndex,
	cancelAction,
	items,
}: {
	productId: string;
	entityIndex?: number;
	cancelAction?: "cancel_end_of_cycle" | "cancel_immediately" | "uncancel";
	items?: ProductItem[];
}): ConfigFn => {
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "updateSubscription" as const,
				productId,
				entityIndex,
				cancelAction,
				items,
			},
		],
	});
};

/**
 * Advance the test clock to the next invoice cycle. `withPause` advances in
 * two steps (month boundary, then finalize).
 */
const advanceToNextInvoice = ({
	withPause,
}: {
	withPause?: boolean;
} = {}): ConfigFn => {
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "advanceToNextInvoice" as const,
				withPause,
			},
		],
	});
};

/**
 * Reset a feature's usage cycle. Use for FREE products (no subscription);
 * use s.advanceToNextInvoice() for PAID products.
 * @example s.resetFeature({ featureId: TestFeature.Messages })
 */
const resetFeature = ({
	featureId,
	timeout,
}: {
	featureId: string;
	timeout?: number;
}): ConfigFn => {
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "resetFeature" as const,
				featureId,
				timeout,
			},
		],
	});
};

/**
 * Delete a customer before the test runs (silent if missing). Clears cache via API.
 * @example s.deleteCustomer({ customerId: "test-customer" })
 * @example s.deleteCustomer({ email: "test@example.com" })
 */
const deleteCustomer = (
	params: { customerId: string } | { email: string },
): ConfigFn => {
	return (config) => {
		if ("customerId" in params) {
			return {
				...config,
				cleanup: {
					...config.cleanup,
					customerIdsToDelete: [
						...config.cleanup.customerIdsToDelete,
						params.customerId,
					],
				},
			};
		}
		return {
			...config,
			cleanup: {
				...config.cleanup,
				emailsToDelete: [...config.cleanup.emailsToDelete, params.email],
			},
		};
	};
};

/**
 * Attach a product via /v1/billing.attach (V2). Product ID auto-prefixed.
 * Add-on lives on the product (`products.recurringAddOn()`), not here.
 * @example s.billing.attach({ productId: "pro" })
 * @example s.billing.attach({ productId: "pro", planSchedule: "end_of_cycle" })
 * @example s.billing.attach({ productId: "pro", items: [items.monthlyMessages({ includedUsage: 750 })] })
 */
const billingAttach = ({
	productId,
	customerId,
	entityIndex,
	options,
	licenseQuantities,
	newBillingSubscription,
	planSchedule,
	timeout,
	items,
	subscriptionId,
	invoice,
	enableProductImmediately,
	finalizeInvoice,
	billingControls,
}: {
	productId: string;
	customerId?: string;
	entityIndex?: number;
	options?: FeatureOption[];
	licenseQuantities?: LicenseQuantityOption[];
	newBillingSubscription?: boolean;
	planSchedule?: PlanTiming;
	timeout?: number;
	items?: ProductItem[];
	subscriptionId?: string;
	invoice?: boolean;
	enableProductImmediately?: boolean;
	finalizeInvoice?: boolean;
	billingControls?: CustomerBillingControlsParams;
}): ConfigFn => {
	const concurrency = Number(process.env.TEST_FILE_CONCURRENCY || "0");
	const defaultTimeout = concurrency > 1 ? 8000 : 5000;
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "billingAttach" as const,
				productId,
				customerId,
				entityIndex,
				options,
				licenseQuantities,
				newBillingSubscription,
				planSchedule,
				timeout: timeout ?? defaultTimeout,
				items,
				subscriptionId,
				invoice,
				enableProductImmediately,
				finalizeInvoice,
				billingControls,
			},
		],
	});
};

/**
 * Multi-attach via /billing.multi_attach.
 * @example s.billing.multiAttach({ plans: [{ productId: "pro" }, { productId: "addon" }] })
 */
const billingMultiAttach = ({
	plans,
	entityIndex,
	freeTrial,
	timeout,
}: {
	plans: MultiAttachPlan[];
	entityIndex?: number;
	freeTrial?: { length: number; duration: string; card_required?: boolean };
	timeout?: number;
}): ConfigFn => {
	const concurrency = Number(process.env.TEST_FILE_CONCURRENCY || "0");
	const defaultTimeout = concurrency > 1 ? 5000 : 2000;
	return (config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "billingMultiAttach" as const,
				plans,
				entityIndex,
				freeTrial,
				timeout: timeout ?? defaultTimeout,
			},
		],
	});
};

/** Top-level alias for billing multi-attach. */
const multiAttach = billingMultiAttach;

const linkLicense =
	({
		parentProductId,
		licenseProductId,
		included,
		prepaidOnly,
		customize,
		metadata,
	}: {
		parentProductId: string;
		licenseProductId: string;
		included: number;
		prepaidOnly?: boolean;
		customize?: PlanLicenseParams["customize"];
		metadata?: Record<string, unknown>;
	}): ConfigFn =>
	(config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "linkLicense" as const,
				parentProductId,
				licenseProductId,
				included,
				prepaidOnly,
				customize,
				metadata,
			},
		],
	});

const assignLicense =
	({
		licenseProductId,
		entityIndex,
		entityIndexes,
		parentProductId,
	}: {
		licenseProductId: string;
		entityIndex?: number;
		entityIndexes?: number[];
		parentProductId?: string;
	}): ConfigFn =>
	(config) => ({
		...config,
		actions: [
			...config.actions,
			{
				type: "assignLicense" as const,
				licenseProductId,
				entityIndex,
				entityIndexes,
				parentProductId,
			},
		],
	});

/** Run independent scenario actions concurrently. */
const parallel = (...actions: ConfigFn[]): ConfigFn => {
	return (config) => {
		const parallelConfig = actions.reduce((c, fn) => fn(c), {
			...config,
			actions: [],
		} as ScenarioConfig);

		return {
			...config,
			actions: [
				...config.actions,
				{ type: "parallel" as const, actions: parallelConfig.actions },
			],
		};
	};
};

/**
 * Provision a fresh platform sub-org via `POST /platform/organizations` and
 * rebind ctx to it for the rest of the scenario. Use to isolate tests that
 * mutate org-level config.
 *
 * Sub-orgs are NOT auto-cleaned; `bun cm` runs `clearMasterOrg` to delete
 * them. Slugs are randomized by default to avoid collisions.
 *
 * @param slug - Sub-org slug; defaults to randomized "tax-XXXXXX".
 * @param name - Display name; defaults to slug.
 * @param userEmail - Owner email; defaults to "platform-tests@autumn.test".
 * @param configOverrides - Merged into the sub-org's config jsonb.
 * @param setupDefaultFeatures - Inserts standard test features on the sub-org.
 *
 * @example s.platform.create({ configOverrides: { automatic_tax: true } })
 */
const platformCreate = (cfg: PlatformCreateConfig = {}): ConfigFn => {
	return (config) => ({
		...config,
		platformConfig: cfg,
	});
};

/** Scenario configuration functions for use with `initScenario`. */
export const s = {
	customer,
	otherCustomers,
	products,
	entities,
	attach,
	cancel,
	advanceTestClock,
	advanceToNextInvoice,
	warmEntityCaches,
	track,
	updateSubscription,
	deleteCustomer,
	resetFeature,
	billing: {
		attach: billingAttach,
		multiAttach: billingMultiAttach,
	},
	licenses: {
		link: linkLicense,
		assign: assignLicense,
	},
	multiAttach,
	parallel,
	platform: {
		create: platformCreate,
	},
} as const;

// ═══════════════════════════════════════════════════════════════════
// INIT SCENARIO
// ═══════════════════════════════════════════════════════════════════

const defaultConfig: ScenarioConfig = {
	testClock: false,
	withDefault: false,
	defaultGroup: undefined,
	products: [],
	productPrefix: undefined,
	cleanup: {
		customerIdsToDelete: [],
		emailsToDelete: [],
	},
	actions: [],
	otherCustomers: [],
};

/**
 * Build a test scenario from setup/actions config functions. Customer
 * creation is skipped when `customerId` is omitted (useful for null-id tests).
 * Actions execute in array order.
 *
 * @example
 * ```typescript
 * const { autumnV1, ctx } = await initScenario({
 *   customerId: "simple-test",
 *   setup: [s.customer({ paymentMethod: "success" }), s.products({ list: [free] })],
 *   actions: [s.attach({ productId: "base" })],
 * });
 * ```
 */
type OtherCustomerResult = {
	id: string;
	customer: Awaited<ReturnType<typeof initTestCustomer>>["customer"];
};

type InitScenarioImplementationResult = {
	customerId: string | undefined;
	autumnV0: AutumnInt;
	autumnV1: AutumnInt;
	autumnV1Beta: AutumnInt;
	/** @deprecated Use autumnV2_2 instead */
	autumnV2: AutumnInt;
	/** @deprecated Use autumnV2_2 instead */
	autumnV2_1: AutumnInt;
	autumnV2_2: AutumnInt;
	autumnV2_3: AutumnInt;
	autumnV2_4: AutumnInt;
	customer: Awaited<ReturnType<typeof initTestCustomer>>["customer"] | null;
	ctx: TestContext;
	entities: GeneratedEntity[];
	licenseAssignments: GeneratedLicenseAssignment[];
	advancedTo: number;
	otherCustomers: Map<string, OtherCustomerResult>;
};

// customerId provided -> customerId: string in return.
export async function initScenario(params: {
	customerId: string;
	setup: ConfigFn[];
	actions: ConfigFn[];
	ctx?: TestContext;
}): Promise<{
	customerId: string;
	autumnV0: AutumnInt;
	autumnV1: AutumnInt;
	autumnV1Beta: AutumnInt;
	/** @deprecated Use autumnV2_2 instead */
	autumnV2: AutumnInt;
	/** @deprecated Use autumnV2_2 instead */
	autumnV2_1: AutumnInt;
	autumnV2_2: AutumnInt;
	autumnV2_3: AutumnInt;
	autumnV2_4: AutumnInt;
	customer: Awaited<ReturnType<typeof initTestCustomer>>["customer"];
	ctx: TestContext;
	entities: GeneratedEntity[];
	licenseAssignments: GeneratedLicenseAssignment[];
	advancedTo: number;
	otherCustomers: Map<string, OtherCustomerResult>;
}>;

// customerId omitted -> customerId: undefined in return.
export async function initScenario(params: {
	customerId?: undefined;
	setup: ConfigFn[];
	actions: ConfigFn[];
	ctx?: TestContext;
}): Promise<{
	customerId: undefined;
	autumnV0: AutumnInt;
	autumnV1: AutumnInt;
	autumnV1Beta: AutumnInt;
	/** @deprecated Use autumnV2_2 instead */
	autumnV2: AutumnInt;
	/** @deprecated Use autumnV2_2 instead */
	autumnV2_1: AutumnInt;
	autumnV2_2: AutumnInt;
	autumnV2_3: AutumnInt;
	autumnV2_4: AutumnInt;
	customer: null;
	ctx: TestContext;
	entities: GeneratedEntity[];
	licenseAssignments: GeneratedLicenseAssignment[];
	advancedTo: number;
	otherCustomers: Map<string, OtherCustomerResult>;
}>;

export async function initScenario({
	customerId,
	setup,
	actions,
	ctx: ctxOverride,
}: {
	customerId?: string;
	setup: ConfigFn[];
	actions: ConfigFn[];
	ctx?: TestContext;
}): Promise<InitScenarioImplementationResult> {
	// Use override or default ctx; may be rebound below if s.platform.create.
	let ctx = ctxOverride ?? defaultCtx;
	const config = [...setup, ...actions].reduce((c, fn) => fn(c), defaultConfig);

	// Sub-org provisioning runs first so subsequent setup hits the sub-org.
	if (config.platformConfig) {
		const masterAutumn = new AutumnInt({ secretKey: ctx.orgSecretKey });

		const slug =
			config.platformConfig.slug ??
			`tax-${Math.random().toString(36).slice(2, 8)}`;
		const userEmail =
			config.platformConfig.userEmail ?? "platform-tests@autumn.test";
		const name = config.platformConfig.name ?? slug;

		const response = (await masterAutumn.post("/platform/organizations", {
			user_email: userEmail,
			name,
			slug,
			env: "test",
		})) as {
			test_secret_key: string;
			live_secret_key?: string;
			org_slug: string;
		};

		ctx = await createSubOrgTestContext({
			subOrgSlug: response.org_slug,
			testSecretKey: response.test_secret_key,
			configOverrides: config.platformConfig.configOverrides,
				setupDefaultFeatures: config.platformConfig.setupDefaultFeatures,
		});

		console.log(
			"[TEST] Creating sub-org:",
			slug,
			" | Impersonate via: ",
			`${process.env.AUTUMN_TEST_VITE_URL ?? "http://localhost:3000"}/impersonate-redirect?org_id=${ctx.org.id}`,
		);
	}

	// Generate entities from config
	const generatedEntities = config.entityConfig
		? generateEntities(config.entityConfig)
		: [];

	// Create a cleanup autumn client
	const cleanupAutumn = new AutumnInt({
		version: ApiVersion.V1_2,
		secretKey: ctx.orgSecretKey,
	});

	// 0. Run cleanup - delete customers by ID and email before test
	for (const customerIdToDelete of config.cleanup.customerIdsToDelete) {
		try {
			await cleanupAutumn.customers.delete(customerIdToDelete);
		} catch {}
	}

	for (const emailToDelete of config.cleanup.emailsToDelete) {
		const customers = await CusService.getByEmail({
			db: ctx.db,
			email: emailToDelete,
			orgId: ctx.org.id,
			env: ctx.env,
		});

		for (const customerToDelete of customers) {
			try {
				await cleanupAutumn.customers.delete(customerToDelete.internal_id);
			} catch {}
		}
	}

	// 1. Products + previous-customer cleanup. Prefix priority:
	// productPrefix > customerId > "shared".
	const productPrefix = config.productPrefix ?? customerId ?? "shared";

	const otherCustomerIds = config.otherCustomers.map((c) => c.id);
	const allCustomerIds = config.customerIds ?? [
		...(customerId ? [customerId] : []),
		...otherCustomerIds,
	];

	if (config.products.length > 0) {
		await initTestProducts({
			ctx,
			products: config.products,
			prefix: productPrefix,
			customerIds: allCustomerIds,
		});
	}

	// 2. Initialize customer (only if customerId is provided)
	let customer: Awaited<ReturnType<typeof initTestCustomer>>["customer"] | null =
		null;

	if (customerId) {
		const result = await initTestCustomer({
			ctx,
			customerId,
			customerData: config.customerData,
			withDefault: config.withDefault ?? false,
			// Default group matches the product prefix used in initTestProducts.
			defaultGroup: config.defaultGroup ?? customerId,
			skipWebhooks: config.skipWebhooks,
			sendEmailReceipts: config.sendEmailReceipts,
			nameOverride: config.nameOverride,
			emailOverride: config.emailOverride,
		});
		customer = result.customer;
	}

	// 2.5. Initialize other customers.
	const otherCustomersMap = new Map<string, OtherCustomerResult>();
	for (const otherCusConfig of config.otherCustomers) {
		const otherResult = await initTestCustomer({
			ctx,
			customerId: otherCusConfig.id,
			customerData: otherCusConfig.data,
			withDefault: false,
			defaultGroup: productPrefix,
			skipWebhooks: config.skipWebhooks,
		});
		otherCustomersMap.set(otherCusConfig.id, {
			id: otherCusConfig.id,
			customer: otherResult.customer,
		});
	}

	// 3. Create autumn clients
	const autumnV0 = new AutumnInt({
		version: ApiVersion.V0_2,
		secretKey: ctx.orgSecretKey,
	});

	const autumnV1 = new AutumnInt({
		version: ApiVersion.V1_2,
		secretKey: ctx.orgSecretKey,
	});

	const autumnV1Beta = new AutumnInt({
		version: ApiVersion.V1_Beta,
		secretKey: ctx.orgSecretKey,
	});

	const autumnV2 = new AutumnInt({
		version: ApiVersion.V2_0,
		secretKey: ctx.orgSecretKey,
	});

	const autumnV2_1 = new AutumnInt({
		version: ApiVersion.V2_1,
		secretKey: ctx.orgSecretKey,
	});
	const autumnV2_2 = new AutumnInt({
		version: ApiVersion.V2_2,
		secretKey: ctx.orgSecretKey,
	});
	const autumnV2_3 = new AutumnInt({
		version: ApiVersion.V2_3,
		secretKey: ctx.orgSecretKey,
	});
	const autumnV2_4 = new AutumnInt({
		version: ApiVersion.V2_4,
		secretKey: ctx.orgSecretKey,
	});

	// 4. Entities (requires customerId).
	if (generatedEntities.length > 0) {
		if (!customerId) {
			throw new Error(
				"Cannot create entities: customerId is required when using s.entities()",
			);
		}
		const defaultGroup = config.entityConfig?.defaultGroup;
		const entityDefs = generatedEntities.map((e) => ({
			id: e.id,
			name: e.name,
			feature_id: e.featureId,
			...(defaultGroup && {
				customer_data: {
					internal_options: {
						default_group: defaultGroup,
					},
				},
			}),
		}));
		await autumnV1.entities.create(customerId, entityDefs);
	}

	// 5. Run actions in order.
	let advancedTo: number = Date.now();
	const licenseAssignments: GeneratedLicenseAssignment[] = [];
	// plans.update takes the complete link set, so sequential link actions on
	// the same parent accumulate here instead of clobbering earlier links.
	const catalogLinksByParent = new Map<string, Record<string, unknown>[]>();

	const runAction = async (action: ScenarioAction): Promise<void> => {
		if (action.type === "parallel") {
			await Promise.all(action.actions.map((child) => runAction(child)));
		} else if (action.type === "attach") {
			// Override or fall back to primary customerId.
			const targetCustomerId = action.customerId ?? customerId;
			if (!targetCustomerId) {
				throw new Error(
					"Cannot attach product: customerId is required when using s.attach()",
				);
			}
			const prefixedProductId = productPrefix
				? `${action.productId}_${productPrefix}`
				: action.productId;

			let entityId: string | undefined;
			if (action.entityIndex !== undefined) {
				if (action.entityIndex >= generatedEntities.length) {
					throw new Error(
						`entityIndex ${action.entityIndex} is out of bounds. Only ${generatedEntities.length} entities configured.`,
					);
				}
				entityId = generatedEntities[action.entityIndex].id;
			}

			await autumnV1.attach({
				customer_id: targetCustomerId,
				product_id: prefixedProductId,
				entity_id: entityId,
				options: action.options,
				new_billing_subscription: action.newBillingSubscription,
			});
			if (action.timeout) {
				await new Promise((resolve) => setTimeout(resolve, action.timeout));
			}
		} else if (action.type === "cancel") {
			if (!customerId) {
				throw new Error(
					"Cannot cancel product: customerId is required when using s.cancel()",
				);
			}
			const prefixedProductId = `${action.productId}_${productPrefix}`;

			let entityId: string | undefined;
			if (action.entityIndex !== undefined) {
				if (action.entityIndex >= generatedEntities.length) {
					throw new Error(
						`entityIndex ${action.entityIndex} is out of bounds. Only ${generatedEntities.length} entities configured.`,
					);
				}
				entityId = generatedEntities[action.entityIndex].id;
			}

			await autumnV1.cancel({
				customer_id: customerId,
				product_id: prefixedProductId,
				entity_id: entityId,
			});
		} else if (action.type === "advanceClock") {
			if (!customer) {
				throw new Error(
					"Cannot advance the billing cycle: no customer was created for this scenario",
				);
			}

			const startingFrom = new Date(advancedTo);

			if (action.toNextInvoice) {
				// Advance to next month + hours to finalize invoice
				const baseDate = startingFrom ?? new Date();
				const target = addHours(
					addMonths(baseDate, 1),
					hoursToFinalizeInvoice,
				).getTime();
				advancedTo = target;
				await advanceBillingCycle({
					db: ctx.db,
					internalCustomerId: customer.internal_id,
					deltaMs: target - startingFrom.getTime(),
				});
			} else {
				const target = addBillingDelta({
					startingFrom,
					days: action.days,
					weeks: action.weeks,
					hours: action.hours,
					months: action.months,
				});
				advancedTo = target.getTime();
				await advanceBillingCycle({
					db: ctx.db,
					internalCustomerId: customer.internal_id,
					deltaMs: target.getTime() - startingFrom.getTime(),
				});
			}
		} else if (action.type === "warmEntityCaches") {
			if (!customerId) {
				throw new Error(
					"Cannot warm entity caches: customerId is required when using s.warmEntityCaches()",
				);
			}
			await warmEntityCachesFn({
				autumn: autumnV1,
				customerId,
				entities: generatedEntities,
			});
		} else if (action.type === "track") {
			if (!customerId) {
				throw new Error(
					"Cannot track usage: customerId is required when using s.track()",
				);
			}

			let entityId: string | undefined;
			if (action.entityIndex !== undefined) {
				if (action.entityIndex >= generatedEntities.length) {
					throw new Error(
						`entityIndex ${action.entityIndex} is out of bounds. Only ${generatedEntities.length} entities configured.`,
					);
				}
				entityId = generatedEntities[action.entityIndex].id;
			}

			await autumnV1.track({
				customer_id: customerId,
				feature_id: action.featureId,
				value: action.value,
				properties: action.properties,
				entity_id: entityId,
			});
			if (action.timeout) {
				await new Promise((resolve) => setTimeout(resolve, action.timeout));
			}
		} else if (action.type === "updateSubscription") {
			if (!customerId) {
				throw new Error(
					"Cannot update subscription: customerId is required when using s.updateSubscription()",
				);
			}
			const prefixedProductId = `${action.productId}_${productPrefix}`;

			let entityId: string | undefined;
			if (action.entityIndex !== undefined) {
				if (action.entityIndex >= generatedEntities.length) {
					throw new Error(
						`entityIndex ${action.entityIndex} is out of bounds. Only ${generatedEntities.length} entities configured.`,
					);
				}
				entityId = generatedEntities[action.entityIndex].id;
			}

			await autumnV1.subscriptions.update({
				customer_id: customerId,
				product_id: prefixedProductId,
				entity_id: entityId,
				cancel_action: action.cancelAction,
				items: action.items,
			});
		} else if (action.type === "advanceToNextInvoice") {
			if (!customer) {
				throw new Error(
					"Cannot advance to next invoice: no customer was created for this scenario",
				);
			}

			const startingFrom = new Date(advancedTo);
			if (action.withPause) {
				const monthBoundary = addMonths(startingFrom, 1).getTime();
				await advanceBillingCycle({
					db: ctx.db,
					internalCustomerId: customer.internal_id,
					deltaMs: monthBoundary - startingFrom.getTime(),
				});
				const finalizeAt = addHours(
					new Date(monthBoundary),
					hoursToFinalizeInvoice,
				).getTime();
				await advanceBillingCycle({
					db: ctx.db,
					internalCustomerId: customer.internal_id,
					deltaMs: finalizeAt - monthBoundary,
				});
				advancedTo = finalizeAt;
			} else {
				const target = addHours(
					addMonths(startingFrom, 1),
					hoursToFinalizeInvoice,
				).getTime();
				await advanceBillingCycle({
					db: ctx.db,
					internalCustomerId: customer.internal_id,
					deltaMs: target - startingFrom.getTime(),
				});
				advancedTo = target;
			}
		} else if (action.type === "billingAttach") {
			// Override or fall back to primary customerId.
			const targetCustomerId = action.customerId ?? customerId;
			if (!targetCustomerId) {
				throw new Error(
					"Cannot attach product: customerId is required when using s.billing.attach()",
				);
			}
			const prefixedProductId = `${action.productId}_${productPrefix}`;

			let entityId: string | undefined;
			if (action.entityIndex !== undefined) {
				if (action.entityIndex >= generatedEntities.length) {
					throw new Error(
						`entityIndex ${action.entityIndex} is out of bounds. Only ${generatedEntities.length} entities configured.`,
					);
				}
				entityId = generatedEntities[action.entityIndex].id;
			}

			await autumnV1.billing.attach(
				{
					customer_id: targetCustomerId,
					product_id: prefixedProductId,
					entity_id: entityId,
					options: action.options,
					license_quantities: action.licenseQuantities?.map(
						({ licenseProductId, quantity }) => ({
							license_plan_id: `${licenseProductId}_${productPrefix}`,
							quantity,
						}),
					),
					new_billing_subscription: action.newBillingSubscription,
					plan_schedule: action.planSchedule,
					items: action.items,
					subscription_id: action.subscriptionId,
					invoice: action.invoice,
					enable_product_immediately: action.enableProductImmediately,
					finalize_invoice: action.finalizeInvoice,
					billing_controls: action.billingControls,
				},
				{ timeout: action.timeout },
			);
		} else if (action.type === "billingMultiAttach") {
			if (!customerId) {
				throw new Error(
					"Cannot multi-attach: customerId is required when using s.billing.multiAttach()",
				);
			}

			let entityId: string | undefined;
			if (action.entityIndex !== undefined) {
				if (action.entityIndex >= generatedEntities.length) {
					throw new Error(
						`entityIndex ${action.entityIndex} is out of bounds. Only ${generatedEntities.length} entities configured.`,
					);
				}
				entityId = generatedEntities[action.entityIndex].id;
			}

			// Build plans with prefixed product IDs
			const plans = action.plans.map((plan) => ({
				plan_id: `${plan.productId}_${productPrefix}`,
				feature_quantities: plan.featureQuantities?.map((fq) => ({
					feature_id: fq.feature_id,
					quantity: fq.quantity,
				})),
				version: plan.version,
			}));

			await autumnV1.billing.multiAttach(
				{
					customer_id: customerId,
					entity_id: entityId,
					plans,
					free_trial: action.freeTrial,
				},
				{ timeout: action.timeout },
			);
		} else if (action.type === "linkLicense") {
			const parentPlanId = `${action.parentProductId}_${productPrefix}`;
			const entry = {
				license_plan_id: `${action.licenseProductId}_${productPrefix}`,
				included: action.included,
				prepaid_only: action.prepaidOnly,
				customize: action.customize,
				metadata: action.metadata,
			};
			const links = (catalogLinksByParent.get(parentPlanId) ?? []).filter(
				(link) => link.license_plan_id !== entry.license_plan_id,
			);
			links.push(entry);
			catalogLinksByParent.set(parentPlanId, links);
			await autumnV2_2.post("/plans.update", {
				plan_id: parentPlanId,
				licenses: links,
			});
		} else if (action.type === "assignLicense") {
			if (!customerId) {
				throw new Error(
					"Cannot assign license: customerId is required when using s.licenses.assign()",
				);
			}
			const entityIndexes =
				action.entityIndexes ??
				(action.entityIndex !== undefined ? [action.entityIndex] : []);
			if (entityIndexes.length === 0) {
				throw new Error(
					"s.licenses.assign() requires entityIndex or entityIndexes",
				);
			}
			for (const index of entityIndexes) {
				if (index >= generatedEntities.length) {
					throw new Error(
						`entityIndex ${index} is out of bounds. Only ${generatedEntities.length} entities configured.`,
					);
				}
			}
			const entityIds = entityIndexes.map(
				(index) => generatedEntities[index].id,
			);
			const licensePlanId = `${action.licenseProductId}_${productPrefix}`;
			await autumnV2_2.post("/licenses.attach", {
				customer_id: customerId,
				plan_id: licensePlanId,
				entities: entityIds.map((entityId) => ({ entity_id: entityId })),
			});
			const { list } = (await autumnV2_2.post("/licenses.list_assignments", {
				customer_id: customerId,
				plan_id: licensePlanId,
				active: true,
			})) as { list: GeneratedLicenseAssignment[] };
			const assignedIds = new Set(entityIds);
			licenseAssignments.push(
				...list.filter((assignment) => assignedIds.has(assignment.entity_id)),
			);
		} else if (action.type === "resetFeature") {
			if (!customerId) {
				throw new Error(
					"Cannot reset feature: customerId is required when using s.resetFeature()",
				);
			}
			if (!customer) {
				throw new Error(
					"Cannot reset feature: customer not initialized. Ensure s.customer() is in setup.",
				);
			}

			// Product group is always productPrefix; productId param is unused.
			const productGroup = productPrefix;

			await resetAndGetCusEnt({
				ctx,
				customer,
				productGroup,
				featureId: action.featureId,
			});

			// Wait for cache to clear.
			const waitTime = action.timeout ?? 2000;
			await new Promise((resolve) => setTimeout(resolve, waitTime));
	}
	};

	for (const action of config.actions) {
		await runAction(action);
	}

	return {
		customerId,
		autumnV0,
		autumnV1,
		autumnV1Beta,
		autumnV2,
		autumnV2_1,
		autumnV2_2,
		autumnV2_3,
		autumnV2_4,
		customer,
		ctx,
		entities: generatedEntities,
		licenseAssignments,
		advancedTo,
		otherCustomers: otherCustomersMap,
	};
}
