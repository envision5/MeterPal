// POST /v1/served_models
//
// Create or update one row of the org's price sheet.
//
// The row is the merchant's price for a model: once it exists, a change in
// the provider's price cannot move what the merchant charges.  That is the
// whole point of the table, so an update here takes effect on the next
// request — and only on the next request, because a request already admitted
// settles at the price it was admitted at.

import { and, eq } from "drizzle-orm";
import { Scopes, servedModels } from "@autumn/shared";
import { z } from "zod/v4";
import { generateId } from "@/utils/genUtils.js";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { syncOrgLitellmKeys } from "@/internal/keys/litellmKeys.js";
import { recordConfigAudit } from "@/internal/audit/configAudit.js";

export const handleUpsertServedModel = createRoute({
	scopes: [Scopes.Organisation.Write],
	body: z.object({
		model_id: z.string().min(1, "A model id is required"),
		display_name: z.string().nullish(),
		upstream_model: z.string().nullish(),
		enabled: z.boolean().optional(),
		input_cost_usd_1m: z.number().nonnegative().nullish(),
		output_cost_usd_1m: z.number().nonnegative().nullish(),
		/** Null means "inherit the plan's markup". */
		markup_pct: z.number().nullish(),
	}),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { db, org, env } = ctx;
		const body = c.req.valid("json");

		const now = Date.now();
		const existing = await db.query.servedModels.findFirst({
			where: and(
				eq(servedModels.org_id, org.id),
				eq(servedModels.env, env),
				eq(servedModels.model_id, body.model_id),
			),
		});

		const values = {
			display_name: body.display_name ?? existing?.display_name ?? null,
			upstream_model: body.upstream_model ?? existing?.upstream_model ?? null,
			enabled: body.enabled ?? existing?.enabled ?? true,
			input_cost_usd_1m:
				body.input_cost_usd_1m ?? existing?.input_cost_usd_1m ?? null,
			output_cost_usd_1m:
				body.output_cost_usd_1m ?? existing?.output_cost_usd_1m ?? null,
			markup_pct: body.markup_pct ?? existing?.markup_pct ?? null,
			updated_at: now,
		};

		const row = existing
			? await db
					.update(servedModels)
					.set(values)
					.where(eq(servedModels.internal_id, existing.internal_id))
					.returning()
			: await db
					.insert(servedModels)
					.values({
						internal_id: generateId("served_model"),
						org_id: org.id,
						env,
						model_id: body.model_id,
						created_at: now,
						...values,
					})
					.returning();

		// Spec §5: every price-sheet edit (including a price change) lands in
		// the config audit trail.
		await recordConfigAudit({
			ctx,
			action: "served_model.upsert",
			resource: body.model_id,
			metadata: {
				created: !existing,
				enabled: values.enabled,
				input_cost_usd_1m: values.input_cost_usd_1m,
				output_cost_usd_1m: values.output_cost_usd_1m,
				markup_pct: values.markup_pct,
			},
		});

		// The gateway enforces the model allow-list on the key, so the
		// merchant's price sheet has to reach it, not just this server.
		// A model that is enabled here but not on the key would 404 at the
		// gateway, which reads as "the model is broken" to the merchant.
		const sync = await syncOrgLitellmKeys(ctx, org.id);

		return c.json({
			model: {
				model_id: row[0].model_id,
				display_name: row[0].display_name,
				upstream_model: row[0].upstream_model,
				enabled: row[0].enabled,
				input_cost_usd_1m: row[0].input_cost_usd_1m,
				output_cost_usd_1m: row[0].output_cost_usd_1m,
				markup_pct: row[0].markup_pct,
				updated_at: row[0].updated_at,
			},
			// How many of the org's inference keys now carry the new
			// allow-list.
			keys_synced: sync.synced,
			keys_failed: sync.failed,
		});
	},
});
