import {
	AppEnv,
	createdAtToVersion,
	customers,
	type Organization,
	RecaseError,
} from "@autumn/shared";
import { and, eq } from "drizzle-orm";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { OrgService } from "@/internal/orgs/OrgService.js";
import { createCustomerWithDefaults } from "@/internal/customers/actions/createWithDefaults/createCustomerWithDefaults.js";

/** Every preview checkout bills this single throwaway end user. */
export const PREVIEW_CUSTOMER_ID = "preview_customer";

/**
 * Builds the deterministic preview org slug for a user
 */
export function buildPreviewOrgSlug({
	userId,
	masterOrgId,
}: {
	userId: string;
	masterOrgId: string;
}): string {
	return `preview|${userId}|${masterOrgId}`;
}

/**
 * Resolves the preview sandbox org that belongs to the session user.
 *
 * The preview org is derived from the session (user + active org), never from
 * request input, so a caller can only ever reach their own sandbox.
 */
export async function getSessionPreviewOrg({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<Organization> {
	const { db, org: masterOrg, userId } = ctx;

	if (!userId) {
		throw new RecaseError({
			message: "User not authenticated",
			code: "unauthenticated",
			statusCode: 401,
		});
	}

	const previewSlug = buildPreviewOrgSlug({
		userId,
		masterOrgId: masterOrg.id,
	});

	const previewOrg = await OrgService.getBySlug({ db, slug: previewSlug });
	if (!previewOrg) {
		throw new RecaseError({
			message: "Preview org not found. Call /preview/setup first.",
			code: "preview_org_not_found",
			statusCode: 404,
		});
	}

	return previewOrg;
}

/**
 * Builds a request context scoped to the preview sandbox org, so preview
 * operations run against the sandbox instead of the user's real org.
 */
export async function buildPreviewContext({
	ctx,
	previewOrg,
	withFeatures = false,
}: {
	ctx: AutumnContext;
	previewOrg: Organization;
	withFeatures?: boolean;
}): Promise<AutumnContext> {
	const features = withFeatures
		? await FeatureService.list({
				db: ctx.db,
				orgId: previewOrg.id,
				env: AppEnv.Sandbox,
			})
		: [];

	return {
		...ctx,
		org: previewOrg,
		env: AppEnv.Sandbox,
		features,
		// The preview org is its own tenant: resolve its API version from its
		// own creation date rather than inheriting the dashboard's header.
		apiVersion: createdAtToVersion({
			createdAt: previewOrg.created_at ?? undefined,
		}),
	};
}

/**
 * The end user every preview checkout bills, created on first use.
 *
 * Checkout resolves its customer through the normal path, which does not
 * auto-create -- so a preview org that has synced pricing but never created
 * its customer would 404 the checkout. Creating it here keeps "Preview
 * Checkout" working on any synced preview org.
 */
export async function ensurePreviewCustomer({
	ctx,
}: {
	ctx: AutumnContext;
}) {
	const existing = await ctx.db.query.customers.findFirst({
		where: and(
			eq(customers.org_id, ctx.org.id),
			eq(customers.env, ctx.env),
			eq(customers.id, PREVIEW_CUSTOMER_ID),
		),
	});

	if (existing?.id) return existing;

	return createCustomerWithDefaults({
		ctx,
		customerId: PREVIEW_CUSTOMER_ID,
		customerData: { name: "Preview Customer" },
	});
}
