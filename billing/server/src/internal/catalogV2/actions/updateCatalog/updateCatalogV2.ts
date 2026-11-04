import type { UpdateCatalogParams } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv";
import { assertRewardScope } from "@/internal/catalogV2/actions/updateCatalog/errors/assertRewardScope";
import { handleUpdateCatalogErrors } from "@/internal/catalogV2/actions/updateCatalog/errors/handleUpdateCatalogErrors";
import { planCatalogUpdate } from "@/internal/catalogV2/actions/updateCatalog/planCatalogUpdate";
import type { CatalogPhases } from "@/internal/catalogV2/actions/updateCatalog/setup/timeCatalogPhase";
import type { UpdateCatalogContext } from "@/internal/catalogV2/actions/updateCatalog/types/updateCatalogContext";
import type { UpdateCatalogPlan } from "@/internal/catalogV2/actions/updateCatalog/types/updateCatalogPlan";
import {
	type CatalogResult,
	executeUpdateCatalogPlan,
} from "@/internal/catalogV2/execute/executeUpdateCatalogPlan";
import { addToExtraLogs } from "@/utils/logging/addToExtraLogs";

export type UpdateCatalogActionResult = {
	catalogContext: UpdateCatalogContext;
	updateCatalogPlan: UpdateCatalogPlan;
	/** Absent on preview runs — nothing was written. */
	catalogResult?: CatalogResult;
};

/** Rewards a referral program that outlives this push still points at. */
export async function updateCatalogV2({
	ctx,
	params,
	preview = false,
}: {
	ctx: AutumnContext;
	params: UpdateCatalogParams;
	preview?: boolean;
}): Promise<UpdateCatalogActionResult> {
	const phases: CatalogPhases = {};
	const started = Date.now();

	assertRewardScope({ ctx, params, preview });

	// 1–2. Setup + compute
	const { catalogContext, updateCatalogPlan } = await planCatalogUpdate({
		ctx,
		params,
		preview,
		phases,
	});

	// 3. Errors
	await handleUpdateCatalogErrors({
		ctx,
		catalogContext,
		updateCatalogPlan,
		params,
	});

	if (preview) {
		addToExtraLogs({
			ctx,
			extras: {
				catalogTiming: {
					operation: "preview",
					totalMs: Date.now() - started,
					phases,
				},
			},
		});
		return { catalogContext, updateCatalogPlan };
	}

	// 4. Execute
	const catalogResult = await executeUpdateCatalogPlan({
		ctx,
		updateCatalogPlan,
		phases,
	});

	addToExtraLogs({
		ctx,
		extras: {
			catalogTiming: {
				operation: "update",
				totalMs: Date.now() - started,
				phases,
			},
		},
	});
	return { catalogContext, updateCatalogPlan, catalogResult };
}
