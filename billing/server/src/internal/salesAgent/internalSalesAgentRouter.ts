// billing/server/src/internal/salesAgent/internalSalesAgentRouter.ts
//
// Session-auth surface for the merchant dashboard's Approvals inbox:
//   GET  /sales-agent/proposals              every proposal for this org+env
//   POST /sales-agent/proposals/:id/approve  one click → mints the real plan
//   POST /sales-agent/proposals/:id/reject

import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod/v4";
import {
	apiPlan,
	agentProposals,
	products,
	RecaseError,
	type CreateProductV2Params,
} from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { createProduct } from "@/internal/product/actions/createProduct.js";
import { invalidateProductsCache } from "@/external/redis/actions/productsCache/productsCache.js";
import { getProposal } from "./engine.js";
import { detectAnomaly, getSpendPoints } from "./usageInsights.js";
import { events } from "@autumn/shared";
import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";

export const internalSalesAgentRouter = new Hono<HonoEnv>();

export const handleListProposals = createRoute({
	scopes: [],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const proposals = await ctx.db
			.select()
			.from(agentProposals)
			.where(
				and(
					eq(agentProposals.org_id, ctx.org.id),
					eq(agentProposals.env, ctx.env),
				),
			)
			.orderBy(desc(agentProposals.created_at))
			.limit(100);
		return c.json({ proposals });
	},
});

export const handleApproveProposal = createRoute({
	scopes: [],
	params: z.object({ proposal_id: z.string() }),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { proposal_id } = c.req.valid("param");
		const proposal = await getProposal({ ctx, proposalId: proposal_id });

		if (proposal.kind !== "custom_package") {
			throw new RecaseError({
				message: "Only custom_package proposals are approved by the merchant",
				statusCode: 400,
			});
		}
		if (proposal.status !== "pending_merchant") {
			throw new RecaseError({
				message: `Proposal is already ${proposal.status}`,
				statusCode: 400,
			});
		}

		// Mint the real plan with the exact shape bootstrap uses for one-off
		// credit packs, mapped through the same V1→V2 converter the plans API
		// runs — no bespoke plan-creation path.
		const planId = `pkg_${proposal.id.replace(/^prop_/, "")}`;
		const v1Params = {
			id: planId,
			name: proposal.payload.name,
			description: `Negotiated by the MeterPal sales agent for ${proposal.customer_id}. ${proposal.payload.reasoning}`.slice(
				0,
				400,
			),
			add_on: true,
			auto_enable: false,
			items: [
				{
					feature_id: "ai_tokens",
					included: proposal.payload.credits,
					price: {
						amount: proposal.payload.price_usd,
						interval: "one_off",
						billing_method: "prepaid",
					},
				},
			],
			metadata: { sales_proposal_id: proposal.id },
		};

		const productData = apiPlan.map.paramsV1ToProductV2({
			ctx,
			params: v1Params as any,
		}) as CreateProductV2Params;
		// The converter leaves these unset and createProduct parses strictly.
		productData.is_add_on = true;
		productData.is_default = false;
		productData.group = "";

		// Idempotent on retry: a previous approve that failed after minting
		// (or a double click) leaves the plan behind — reuse it instead of
		// failing the whole decision.
		let product;
		const existing = await ctx.db.query.products.findFirst({
			where: and(
				eq(products.id, planId),
				eq(products.org_id, ctx.org.id),
				eq(products.env, ctx.env),
			),
		});
		if (existing) {
			product = { id: existing.id, name: existing.name };
		} else {
			const created = await createProduct({ ctx, data: productData });
			await invalidateProductsCache({ orgId: ctx.org.id, env: ctx.env });
			product = { id: created.id, name: created.name };
		}

		const [updated] = await ctx.db
			.update(agentProposals)
			.set({ status: "approved", plan_id: product.id, decided_at: new Date() })
			.where(eq(agentProposals.id, proposal.id))
			.returning();

		return c.json({ proposal: updated, plan: product });
	},
});

export const handleRejectProposal = createRoute({
	scopes: [],
	params: z.object({ proposal_id: z.string() }),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { proposal_id } = c.req.valid("param");
		const proposal = await getProposal({ ctx, proposalId: proposal_id });

		if (proposal.status !== "pending_merchant") {
			throw new RecaseError({
				message: `Proposal is already ${proposal.status}`,
				statusCode: 400,
			});
		}

		const [updated] = await ctx.db
			.update(agentProposals)
			.set({ status: "rejected", decided_at: new Date() })
			.where(eq(agentProposals.id, proposal.id))
			.returning();

		return c.json({ proposal: updated });
	},
});

export const handleListAnomalies = createRoute({
	scopes: [],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const featureId = "ai_tokens";
		const sinceMs = Date.now() - 8 * 86_400_000;

		// One ledger query for the whole org; the per-customer math is the same
		// detectAnomaly the customer-facing surfaces use.
		const rows = await ctx.db
			.select({
				customer_id: events.customer_id,
				timestamp: events.timestamp,
				value: events.value,
			})
			.from(events)
			.where(
				and(
					eq(events.org_id, ctx.org.id),
					eq(events.env, ctx.env),
					eq(events.event_name, featureId),
					gte(events.timestamp, new Date(sinceMs)),
				),
			);

		const byCustomer = new Map<string, { at: number; value: number }[]>();
		for (const row of rows) {
			const points = byCustomer.get(row.customer_id) ?? [];
			points.push({
				at: row.timestamp ? new Date(row.timestamp).getTime() : 0,
				value: row.value ?? 0,
			});
			byCustomer.set(row.customer_id, points);
		}

		const anomalies = [];
		for (const [customerId, points] of byCustomer) {
			const anomaly = detectAnomaly(points);
			if (anomaly.flagged) {
				anomalies.push({
					customer_id: customerId,
					...anomaly,
				});
			}
		}
		anomalies.sort((a, b) => b.last24hSpend - a.last24hSpend);

		return c.json({ anomalies, checked_customers: byCustomer.size });
	},
});

internalSalesAgentRouter.get("/proposals", ...handleListProposals);
internalSalesAgentRouter.get("/anomalies", ...handleListAnomalies);
internalSalesAgentRouter.post(
	"/proposals/:proposal_id/approve",
	...handleApproveProposal,
);
internalSalesAgentRouter.post(
	"/proposals/:proposal_id/reject",
	...handleRejectProposal,
);
