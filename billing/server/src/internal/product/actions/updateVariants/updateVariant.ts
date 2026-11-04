import type {
	ApiPlanV1,
	DiffedCustomizePlanV1,
	FullProduct,
	UpdateVariantParams,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import {
	applyDiffToVariantPlan,
	buildProductUpdatesFromApiPlan,
	fullProductToApiPlanV1,
	getApiPlanDiff,
	getVariantSettingsPatch,
	type VariantSettingsPatch,
	variantSettingsPatchHasValues,
} from "../common/planTransformUtils.js";
import {
	validateDirectVariantControls,
	validateDirectVariantMigrationDraftUnsupported,
	variantCustomizeChanged,
} from "../common/variantUpdateSource.js";
import { updateOtherProductVersions } from "../updateProduct/updateOtherProductVersions.js";
import { updateProduct } from "../updateProduct.js";

export const updateVariant = async ({
	ctx,
	variant,
	diff,
	settingsPatch,
	targetPlan,
	shouldVersion,
	baseInternalProductId,
	allVersions,
	variantUpdate,
}: {
	ctx: AutumnContext;
	variant: FullProduct;
	diff?: DiffedCustomizePlanV1;
	settingsPatch?: VariantSettingsPatch;
	targetPlan?: ApiPlanV1;
	shouldVersion: boolean;
	baseInternalProductId?: string;
	allVersions?: boolean;
	variantUpdate?: UpdateVariantParams;
}) => {
	const currentPlan = await fullProductToApiPlanV1({
		ctx,
		product: variant,
	});
	const isDirectUpdate = variantUpdate
		? variantCustomizeChanged({
				currentCustomize: currentPlan.variant_details?.customize,
				incomingCustomize: variantUpdate.customize,
			})
		: false;
	validateDirectVariantControls({
		isDirect: isDirectUpdate,
		variantPlanId: variant.id,
		hasControls: Boolean(
			variantUpdate?.force_version ||
				variantUpdate?.disable_version ||
				variantUpdate?.migration?.draft,
		),
	});
	validateDirectVariantMigrationDraftUnsupported({
		hasMigrationDraft: Boolean(variantUpdate?.migration?.draft),
		isDirect: isDirectUpdate,
		variantPlanId: variant.id,
	});
	const previewPlan =
		targetPlan ??
		applyDiffToVariantPlan({
			plan: currentPlan,
			diff: diff ?? {},
			settingsPatch,
		});
	const updates = buildProductUpdatesFromApiPlan({
		ctx,
		currentFullProduct: variant,
		plan: previewPlan,
	});

	await updateProduct({
		ctx,
		productId: variant.id,
		query: shouldVersion ? { force_version: true } : { disable_version: true },
		updates,
		initialFullProduct: variant,
		baseInternalProductId,
		allowVariantSettingsUpdate: true,
	});

	// A migration draft would be created here — the migrations module that
	// persists drafts is gone, so it cannot be stored.

	if (!allVersions) return;

	const diffForOtherVersions = getApiPlanDiff({
		from: currentPlan,
		to: previewPlan,
	});
	const settingsForOtherVersions = getVariantSettingsPatch({
		from: currentPlan,
		to: previewPlan,
	});
	await updateOtherProductVersions({
		ctx,
		product: variant,
		diff: diffForOtherVersions,
		settingsPatch: variantSettingsPatchHasValues(settingsForOtherVersions)
			? settingsForOtherVersions
			: undefined,
		updateVersion: async ({ product, updates }) => {
			await updateProduct({
				ctx,
				productId: product.id,
				query: { version: product.version, disable_version: true },
				updates,
				initialFullProduct: product,
				allowVariantSettingsUpdate: true,
				skipVariantUpdates: true,
			});
		},
	});
};
