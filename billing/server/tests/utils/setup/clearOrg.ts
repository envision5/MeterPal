import {
	AppEnv,
	customerProducts,
	migrationItemRuns,
	migrations,
	planLicenses,
	products,
} from "@autumn/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import { initDrizzle } from "@/db/initDrizzle.js";
import { clearSecretKeyCache } from "@/external/redis/actions/secretKeyCache/secretKeyCache.js";
import { CusService } from "@/internal/customers/CusService.js";
import { hashApiKey } from "@/internal/dev/apiKeys/apiKeyUtils.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { OrgService } from "@/internal/orgs/OrgService.js";
import { ProductService } from "@/internal/products/ProductService.js";

/**
 * DB-only org cleanup — no HTTP calls, no connection lifecycle.
 * Safe to call from setup scripts that already hold a db handle.
 */
export const clearOrgDbOnly = async ({
	db,
	orgId,
	env,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
}) => {
	await CusService.deleteByOrgId({ db, orgId, env });

	// customer_products_internal_product_id_fkey has no ON DELETE CASCADE.
	// Explicitly wipe any remaining rows so the subsequent product delete succeeds.
	const orgProductIds = db
		.select({ internal_id: products.internal_id })
		.from(products)
		.where(and(eq(products.org_id, orgId), eq(products.env, env)));

	await db
		.delete(customerProducts)
		.where(inArray(customerProducts.internal_product_id, orgProductIds));

	// license_entitlements/license_prices RESTRICT their item rows; deleting
	// plan_license first cascades the junctions so the product delete can
	// cascade entitlements/prices freely.
	await db
		.delete(planLicenses)
		.where(inArray(planLicenses.parent_internal_product_id, orgProductIds));

	await ProductService.deleteByOrgId({ db, orgId, env });
	await FeatureService.deleteByOrgId({ db, orgId, env });
};

export const clearOrg = async ({
	orgSlug,
	env,
}: {
	orgSlug: string;
	env: AppEnv;
}) => {
	if (env !== AppEnv.Sandbox) {
		console.error("Cannot clear non-sandbox orgs");
		process.exit(1);
	}

	const { db, client } = initDrizzle();
	const org = await OrgService.getBySlug({ db, slug: orgSlug });

	// public_key:* was never written by anything — only the secret key is cached.
	await clearSecretKeyCache({
		hashedKey: hashApiKey(process.env.UNIT_TEST_AUTUMN_SECRET_KEY!),
	});

	if (!org) {
		throw new Error(`Org ${orgSlug} not found`);
	}

	// Allow unit-test-org, ci_cd, and platform test orgs (test-*|org_...)
	const isAllowed =
		org.slug === "unit-test-org" ||
		org.slug === "ci_cd" ||
		org.slug.startsWith("test-");

	if (!isAllowed) {
		console.error("Cannot clear non-unit-test-orgs");
		process.exit(1);
	}

	const orgId = org.id;

	await clearOrgDbOnly({ db, orgId, env });
	console.log("   Deleted customers, products, and features");

	// migration_item_runs has no FK to migrations/org; clear by joining first.
	// migrations cascades to migration_runs, so deleting it is enough.
	const orgMigrations = await db
		.select({ internalId: migrations.internal_id })
		.from(migrations)
		.where(and(eq(migrations.org_id, orgId), eq(migrations.env, env)));
	if (orgMigrations.length > 0) {
		await db.delete(migrationItemRuns).where(
			inArray(
				migrationItemRuns.migration_internal_id,
				orgMigrations.map((m) => m.internalId),
			),
		);
	}
	await db
		.delete(migrations)
		.where(and(eq(migrations.org_id, orgId), eq(migrations.env, env)));
	console.log("   ✅ Deleted migrations + migration item runs");

	console.log(`✅ Cleared org ${orgSlug} (${env})`);

	await client.end();
	return org;
};
