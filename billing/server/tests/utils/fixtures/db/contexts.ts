import type { BillingContext } from "@autumn/shared";
import {
	ApiVersion,
	ApiVersionClass,
	AppEnv,
	BillingVersion,
	type Feature,
	type FullCusProduct,
	type FullProduct,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { customers } from "./customers";

const createTestLogger = () => ({
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => createTestLogger(),
});

/**
 * Create an organization fixture
 */
const createOrg = () => ({
	id: "org_test",
	name: "Test Organization",
	slug: "test-org",
	default_currency: "usd",
});

/**
 * Create an Autumn context fixture
 */
const create = ({
	features = [],
	org,
}: {
	features?: Feature[];
	org?: ReturnType<typeof createOrg>;
}): AutumnContext =>
	({
		features,
		org: org ?? createOrg(),
		apiVersion: new ApiVersionClass(ApiVersion.V1_2),
		env: AppEnv.Sandbox,
		logger: createTestLogger(),
	}) as unknown as AutumnContext;

/**
 * Create a billing context fixture
 */
const createBilling = ({
	customerProducts = [],
	fullProducts = [],
	currentEpochMs = Date.now(),
	billingCycleAnchorMs = "now",
	resetCycleAnchorMs = "now",
	billingVersion = BillingVersion.V1,
}: {
	customerProducts?: FullCusProduct[];
	fullProducts?: FullProduct[];
	currentEpochMs?: number;
	billingCycleAnchorMs?: number | "now";
	resetCycleAnchorMs?: number | "now";
	billingVersion?: BillingVersion;
}): BillingContext => ({
	fullCustomer: customers.create({ customerProducts }),
	fullProducts,
	featureQuantities: [],
	currentEpochMs,
	billingCycleAnchorMs,
	resetCycleAnchorMs,
	customPrices: [],
	customEnts: [],
	isCustom: false,
	billingVersion,
});

// ═══════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════

export const contexts = {
	create,
	createOrg,
	createBilling,
} as const;
