import {
	CustomerNotFoundError,
	type DeleteCustomerParams,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { CusService } from "@/internal/customers/CusService";
import { deleteCachedFullCustomer } from "@/internal/customers/cusUtils/fullCustomerCacheUtils/deleteCachedFullCustomer";

export const deleteCustomer = async ({
	ctx,
	params,
}: {
	ctx: AutumnContext;
	params: DeleteCustomerParams;
}) => {
	const { db, org, env } = ctx;

	const { customer_id: customerId } = params;

	const customer = await CusService.get({
		db,
		idOrInternalId: customerId,
		orgId: org.id,
		env,
	});

	if (!customer) {
		throw new CustomerNotFoundError({ customerId: customerId });
	}

	await CusService.deleteByInternalId({
		db,
		internalId: customer.internal_id,
		orgId: org.id,
		env,
	});

	// Delete customer and all entity caches atomically
	await deleteCachedFullCustomer({
		customerId: customer.id ?? "",
		ctx,
		source: `deleteCustomer`,
	});
};
