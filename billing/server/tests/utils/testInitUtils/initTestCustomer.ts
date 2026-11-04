import { ApiVersion, type CustomerData } from "@autumn/shared";
import type { TestContext } from "@tests/utils/testInitUtils/createTestContext.js";
import { AutumnInt } from "@/external/autumn/autumnCli.js";
import { CusService } from "@/internal/customers/CusService.js";

/**
 * Create an Autumn customer for a test scenario.
 *
 * Processor-neutral replacement for the old `initTestCustomer` harness: the
 * customer is created straight through the Autumn API and no processor-side
 * record (and no processor test clock) is involved.
 */
export const initTestCustomer = async ({
	ctx,
	customerId,
	customerData,
	withDefault = false,
	defaultGroup = customerId,
	skipWebhooks,
	sendEmailReceipts,
	nameOverride,
	emailOverride,
}: {
	ctx: TestContext;
	customerId: string;
	customerData?: CustomerData;
	withDefault?: boolean;
	defaultGroup?: string;
	skipWebhooks?: boolean;
	sendEmailReceipts?: boolean;
	nameOverride?: string | null;
	emailOverride?: string | null;
}) => {
	// Use override if provided (including null), otherwise default to customerId.
	const name =
		nameOverride !== undefined ? (nameOverride ?? undefined) : customerId;
	const email =
		emailOverride !== undefined
			? (emailOverride ?? undefined)
			: `${customerId}@example.co`;

	const autumn = new AutumnInt({
		version: ApiVersion.V1_2,
		secretKey: ctx.orgSecretKey,
	});

	// 1. Recreate the customer from scratch.
	try {
		await autumn.customers.delete(customerId);
	} catch (_error) {}

	await autumn.customers.create({
		id: customerId,
		name,
		email,
		fingerprint: customerData?.fingerprint,
		send_email_receipts: sendEmailReceipts,
		config: customerData?.config,
		currency: customerData?.currency,
		internalOptions: {
			disable_defaults: !withDefault,
			...(withDefault && { default_group: defaultGroup }),
		},
		skipWebhooks,
	});

	const customer = await CusService.getFull({
		ctx,
		idOrInternalId: customerId,
	});

	return { customer };
};
