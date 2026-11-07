// billing/server/src/internal/salesAgent/salesAgentRouter.ts
//
// Secret-key API surface for the agentic layer (called by the merchant's app —
// demo-app proxies it with the x-meterpal-customer header):
//   POST /v1/sales-agent/chat      negotiate with the sales-rep agent
//   GET  /v1/sales-agent/insights  spend math + anomaly flag for one customer
//   GET  /v1/sales-agent/offers    proposals the customer can act on

import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { Scopes, RecaseError, agentProposals } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import {
	buildTurnContext,
	getProposal,
	listProposals,
	runSalesTurn,
} from "./engine.js";
import { findInferenceCustomer } from "@/internal/inference/inferenceService.js";

export const salesAgentRouter = new Hono<HonoEnv>();

const SalesChatParamsSchema = z.object({
	customer_id: z.string().min(1),
	message: z.string().min(1).max(4000),
	history: z
		.array(
			z.object({
				role: z.enum(["customer", "agent"]),
				content: z.string().max(4000),
				// The client-held transcript carries no timestamps; the server
				// stamps them when it persists the conversation on a draft.
				at: z.number().optional(),
			}),
		)
		.max(30)
		.optional(),
});

const stampHistory = (
	history: { role: "customer" | "agent"; content: string; at?: number }[] = [],
) => {
	const now = Date.now();
	return history.map((message, index) => ({
		role: message.role,
		content: message.content,
		at: message.at ?? now - (history.length - index) * 1000,
	}));
};

export const handleSalesAgentChat = createRoute({
	scopes: [Scopes.Customers.Read],
	body: SalesChatParamsSchema,
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { customer_id, message, history } = c.req.valid("json");

		const result = await runSalesTurn({
			ctx,
			customerId: customer_id,
			message,
			history: stampHistory(history),
		});

		return c.json(result);
	},
});

export const handleSalesAgentInsights = createRoute({
	scopes: [Scopes.Customers.Read],
	query: z.object({ customer_id: z.string().min(1) }),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { customer_id } = c.req.valid("query");

		const { turn } = await buildTurnContext({ ctx, customerId: customer_id });

		return c.json({
			customer_id: turn.customerId,
			balance: turn.balance,
			insights: turn.insights,
			mandate: turn.mandate,
		});
	},
});

export const handleSalesAgentOffers = createRoute({
	scopes: [Scopes.Customers.Read],
	query: z.object({ customer_id: z.string().min(1) }),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { customer_id } = c.req.valid("query");

		const proposals = await listProposals({ ctx, customerId: customer_id });
		// The customer's surfaces see offers they can act on, plus anything
		// already purchased (the receipt trail).  Merchant-gate proposals are
		// invisible until approved.
		const actionable = proposals.filter((proposal) =>
			["approved", "pending_customer", "purchased", "declined"].includes(
				proposal.status,
			),
		);

		return c.json({ proposals: actionable });
	},
});

salesAgentRouter.post("/chat", ...handleSalesAgentChat);
salesAgentRouter.get("/insights", ...handleSalesAgentInsights);
salesAgentRouter.get("/offers", ...handleSalesAgentOffers);

// ---- customer decisions on buyer-agent proposals (the human gate) ----

/**
 * The buyer agent (running in the merchant's app) asks the ledger to record a
 * top-up authorization request: the agent wants to buy a pack above the
 * customer's auto-approve line.  The proposal lands in the demo-app Offers
 * panel for the customer to approve; the purchase itself still goes through
 * PayPal's own approval flow.
 */
export const handleAuthorizeTopup = createRoute({
	scopes: [Scopes.Customers.Read],
	body: z.object({
		customer_id: z.string().min(1),
		product_id: z.string().min(1),
		credits: z.number().positive(),
		price_usd: z.number().positive(),
		reason: z.string().min(1).max(1000),
		days_to_empty: z.number().nullable().optional(),
	}),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const params = c.req.valid("json");

		const customer = await findInferenceCustomer({
			db: ctx.db,
			orgId: ctx.org.id,
			env: ctx.env,
			idOrInternalId: params.customer_id,
		});
		if (!customer) {
			throw new RecaseError({
				message: `Customer ${params.customer_id} not found`,
				statusCode: 404,
			});
		}

		const proposalId = `prop_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
		const [proposal] = await ctx.db
			.insert(agentProposals)
			.values({
				id: proposalId,
				org_id: ctx.org.id,
				env: ctx.env,
				internal_customer_id: customer.internal_id as string,
				customer_id: customer.id as string,
				kind: "topup_authorization",
				status: "pending_customer",
				payload: {
					name: `${params.credits} credits (agent-authorized)`,
					credits: params.credits,
					price_usd: params.price_usd,
					reasoning: params.reason,
					product_id: params.product_id,
					projected_months: undefined,
				},
				conversation: [],
				created_at: Date.now(),
			})
			.returning();

		return c.json({ proposal });
	},
});

export const handleDeclineProposal = createRoute({
	scopes: [Scopes.Customers.Read],
	params: z.object({ proposal_id: z.string() }),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { proposal_id } = c.req.valid("param");
		const proposal = await getProposal({ ctx, proposalId: proposal_id });

		if (proposal.status !== "pending_customer") {
			throw new RecaseError({
				message: `Proposal is already ${proposal.status}`,
				statusCode: 400,
			});
		}

		const [updated] = await ctx.db
			.update(agentProposals)
			.set({ status: "declined", decided_at: new Date() })
			.where(eq(agentProposals.id, proposal.id))
			.returning();

		return c.json({ proposal: updated });
	},
});

export const handleMarkPurchased = createRoute({
	scopes: [Scopes.Customers.Read],
	params: z.object({ proposal_id: z.string() }),
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { proposal_id } = c.req.valid("param");
		const proposal = await getProposal({ ctx, proposalId: proposal_id });

		if (!["approved", "pending_customer"].includes(proposal.status)) {
			throw new RecaseError({
				message: `Proposal in status ${proposal.status} cannot be marked purchased`,
				statusCode: 400,
			});
		}

		const [updated] = await ctx.db
			.update(agentProposals)
			.set({ status: "purchased", decided_at: new Date() })
			.where(eq(agentProposals.id, proposal.id))
			.returning();

		return c.json({ proposal: updated });
	},
});

salesAgentRouter.post(
	"/proposals/:proposal_id/decline",
	...handleDeclineProposal,
);
salesAgentRouter.post(
	"/proposals/:proposal_id/purchased",
	...handleMarkPurchased,
);
salesAgentRouter.post("/authorize-topup", ...handleAuthorizeTopup);
