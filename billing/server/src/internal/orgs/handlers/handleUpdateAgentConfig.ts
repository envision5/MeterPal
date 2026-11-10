import {
	BuyerAgentDefaultsSchema,
	organizations,
	readAgentConfig,
	Scopes,
	SellerAgentMandateSchema,
	writeAgentConfig,
} from "@autumn/shared";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { clearOrgCache } from "../orgUtils/clearOrgCache.js";

/**
 * Persist the merchant's agent configuration.
 *
 * Both objects are validated by the same schemas the agents execute against,
 * so a structurally invalid ladder (empty, duplicate ids, malformed ids) is
 * rejected here rather than surfacing later as a refused offer.
 *
 * A coupon above `max_discount_pct` is deliberately *not* rejected: a merchant
 * may stage a coupon now and raise the ceiling later.  It is inert until then
 * because `resolveOffer` re-checks the ceiling at offer time, and the settings
 * page flags it.
 *
 * Only the keys present in the request are written; the rest of the metadata
 * blob is preserved.  `clearOrgCache` matters: the sales agent reads
 * `org.metadata` from the cached org row, so without it a saved change would
 * not reach the agent until the cache expired.
 */
const bodySchema = z.object({
	seller_agent_mandate: SellerAgentMandateSchema.optional(),
	buyer_agent_defaults: BuyerAgentDefaultsSchema.optional(),
});

export const handleUpdateAgentConfig = createRoute({
	scopes: [Scopes.Organisation.Write],
	body: bodySchema,
	handler: async (c) => {
		const { db, org } = c.get("ctx");
		const body = c.req.valid("json");

		if (
			body.seller_agent_mandate === undefined &&
			body.buyer_agent_defaults === undefined
		) {
			return c.json(readAgentConfig(org.metadata));
		}

		// Duplicate package ids would make a rung ambiguous to resolve.
		const packages = body.seller_agent_mandate?.packages;
		if (packages) {
			const ids = packages.map((p) => p.package_id);
			if (new Set(ids).size !== ids.length) {
				return c.json(
					{
						message: "Package ids must be unique",
						code: "invalid_request",
						env: c.get("ctx").env,
					},
					400,
				);
			}
		}

		const coupons = body.seller_agent_mandate?.coupons;
		if (coupons) {
			const ids = coupons.map((p) => p.coupon_id);
			if (new Set(ids).size !== ids.length) {
				return c.json(
					{
						message: "Coupon ids must be unique",
						code: "invalid_request",
						env: c.get("ctx").env,
					},
					400,
				);
			}
		}

		const nextMetadata = writeAgentConfig(org.metadata, body);

		await db
			.update(organizations)
			.set({ metadata: nextMetadata })
			.where(eq(organizations.id, org.id));

		await clearOrgCache({ db, orgId: org.id });

		return c.json(readAgentConfig(nextMetadata));
	},
});
