// billing/server/src/internal/models/servedModelService.ts
//
// The per-org price sheet.
//
// `served_models` is the runtime authority for what an org serves and what it
// charges.  The provider's live price (models.dev) is only the SEED used when
// a row is created: once a row exists, a models.dev change cannot silently
// move a merchant's prices.
//
// Precedence, in one place so the track path and the dashboard agree:
//
//   base cost  served_models row  >  models.dev / feature model_markups
//   markup     served_models row  >  feature model_markups -> provider -> default
//
// An org with NO row for a model keeps the old behaviour exactly, so an org
// that has never opened the Models tab is unaffected by this table.

import { AppEnv } from "@autumn/shared";
import { and, eq } from "drizzle-orm";
import { servedModels } from "@autumn/shared";
import type { DrizzleCli } from "@/db/initDrizzle.js";

/** The price the org charges for a model, in USD per 1M tokens. */
export type ServedModelPricing = {
	input: number;
	output: number;
	/** The merchant's markup for this model, in percent. Null = not set. */
	markupPct: number | null;
	/** The org's own row, if it has one. */
	model: ServedModelRow | null;
};

export type ServedModelRow = {
	internal_id: string;
	org_id: string;
	env: string;
	model_id: string;
	display_name: string | null;
	upstream_model: string | null;
	enabled: boolean;
	input_cost_usd_1m: number | null;
	output_cost_usd_1m: number | null;
	markup_pct: number | null;
	created_at: number | null;
	updated_at: number | null;
};

export const listServedModels = async ({
	db,
	orgId,
	env,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
}): Promise<ServedModelRow[]> => {
	const rows = await db.query.servedModels.findMany({
		where: and(eq(servedModels.org_id, orgId), eq(servedModels.env, env)),
	});
	return rows as ServedModelRow[];
};

/**
 * The org's row for one model.
 *
 * Returns null when the org never listed the model, or listed it as disabled:
 * a disabled model is not served, so it must not be priced either.
 */
export const getServedModel = async ({
	db,
	orgId,
	env,
	modelId,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
	modelId: string;
}): Promise<ServedModelRow | null> => {
	const row = await db.query.servedModels.findFirst({
		where: and(
			eq(servedModels.org_id, orgId),
			eq(servedModels.env, env),
			eq(servedModels.model_id, modelId),
		),
	});
	return (row as ServedModelRow | undefined) ?? null;
};

/**
 * The pricing to use for a model, or null when the org has no opinion.
 *
 * A row with no usable costs is treated as no opinion: the caller falls back
 * to the provider price rather than billing at zero.
 */
export const getServedModelPricing = async ({
	db,
	orgId,
	env,
	modelId,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
	modelId: string;
}): Promise<ServedModelPricing | null> => {
	const row = await getServedModel({ db, orgId, env, modelId });
	if (!row) return null;
	if (row.input_cost_usd_1m == null || row.output_cost_usd_1m == null) {
		return null;
	}
	return {
		input: row.input_cost_usd_1m,
		output: row.output_cost_usd_1m,
		markupPct: row.markup_pct,
		model: row,
	};
};

/** The org's served models, as the gateway sees them. */
export const getServedModelCatalog = async ({
	db,
	orgId,
	env,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
}): Promise<
	Array<{
		model_id: string;
		display_name: string | null;
		upstream_model: string | null;
		enabled: boolean;
		input_cost_usd_1m: number | null;
		output_cost_usd_1m: number | null;
		markup_pct: number | null;
	}>
> => {
	const rows = await listServedModels({ db, orgId, env });
	return rows.map((row) => ({
		model_id: row.model_id,
		display_name: row.display_name,
		upstream_model: row.upstream_model,
		enabled: row.enabled,
		input_cost_usd_1m: row.input_cost_usd_1m,
		output_cost_usd_1m: row.output_cost_usd_1m,
		markup_pct: row.markup_pct,
	}));
};

/**
 * Which models an org may call.
 *
 * An org with no rows serves everything the gateway offers: that is the
 * pre-P2 behaviour, and it keeps an org that never touched the Models tab
 * working.  Once the org has rows, the enabled ones are the allow-list.
 */
export const getServedModelAllowList = async ({
	db,
	orgId,
	env,
}: {
	db: DrizzleCli;
	orgId: string;
	env: AppEnv;
}): Promise<string[] | null> => {
	const rows = await listServedModels({ db, orgId, env });
	if (rows.length === 0) return null;
	return rows.filter((r) => r.enabled).map((r) => r.model_id);
};
