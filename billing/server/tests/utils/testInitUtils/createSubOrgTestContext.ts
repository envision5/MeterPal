import {
	ApiVersionClass,
	AppEnv,
	AuthType,
	LATEST_VERSION,
	type OrgConfig,
} from "@autumn/shared";
import { getFeatures } from "@tests/setup/v2Features.js";
import { initDrizzle } from "@/db/initDrizzle.js";
import { resolveRedisV2 } from "@/external/redis/resolveRedisV2.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { OrgService } from "@/internal/orgs/OrgService.js";
import { logger } from "../../../src/external/logtail/logtailUtils.js";
import { generateId } from "../../../src/utils/genUtils.js";
import type { TestContext } from "./createTestContext.js";

export const createSubOrgTestContext = async ({
	subOrgSlug,
	testSecretKey,
	configOverrides,
	setupDefaultFeatures,
}: {
	subOrgSlug: string;
	testSecretKey: string;
	configOverrides?: Partial<OrgConfig>;
	setupDefaultFeatures?: boolean;
}): Promise<TestContext> => {
	const { db } = initDrizzle();

	// 1. Resolve sub-org.
	let subOrg = await OrgService.getBySlug({ db, slug: subOrgSlug });
	if (!subOrg) {
		throw new Error(
			`Sub-org with slug "${subOrgSlug}" not found. ` +
				`Caller must create the sub-org via POST /platform/organizations first.`,
		);
	}

	// 2. Apply config overrides. OrgService.update replaces the whole
	// `config` jsonb, so we merge in JS first.
	if (configOverrides && Object.keys(configOverrides).length > 0) {
		const existingConfig = (subOrg.config ?? {}) as OrgConfig;
		const mergedConfig: OrgConfig = {
			...existingConfig,
			...configOverrides,
		};

		await OrgService.update({
			db,
			orgId: subOrg.id,
			updates: { config: mergedConfig },
		});

		// Re-fetch with merged config.
		const refetched = await OrgService.getBySlug({ db, slug: subOrgSlug });
		if (!refetched) {
			throw new Error(
				`Sub-org with slug "${subOrgSlug}" disappeared after config update`,
			);
		}
		subOrg = refetched;
	}

	if (setupDefaultFeatures) {
		await FeatureService.insert({
			db,
			data: Object.values(getFeatures({ orgId: subOrg.id })),
			logger,
		});
	}

	// 3. Sub-org features.
	const features = await FeatureService.list({
		db,
		orgId: subOrg.id,
		env: AppEnv.Sandbox,
	});

	// 4. TestContext with sub-org rebinding (matches createTestContext shape).
	return {
		org: subOrg,
		env: AppEnv.Sandbox,
		db,
		dbGeneral: db,
		features,
		logger,
		redisV2: resolveRedisV2(),
		orgSecretKey: testSecretKey,
		id: generateId("test"),
		isPublic: false,
		authType: AuthType.Unknown,
		apiVersion: new ApiVersionClass(LATEST_VERSION),
		timestamp: Date.now(),
		scopes: [],
		skipCache: false,
		expand: [],
		extraLogs: {},
	} satisfies TestContext;
};
