import { jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Proposals raised by MeterPal's agents, awaiting a human decision.
//
//   custom_package      the sales-rep agent negotiated a package with a
//                       customer and drafted a plan — a MERCHANT approves or
//                       rejects it, and approval mints the real plan.
//   topup_authorization the buyer agent wants to spend above the customer's
//                       auto-approve line — the CUSTOMER approves it, and the
//                       purchase still goes through PayPal's own approval.
//
// The merchant dashboard's Approvals inbox and the demo-app's Offers panel
// both read this table; `payload` carries everything each surface renders.

export type AgentProposalKind = "custom_package" | "topup_authorization";

export type AgentProposalStatus =
	| "pending_merchant"
	| "pending_customer"
	| "approved"
	| "rejected"
	| "declined"
	| "purchased";

export type AgentProposalPayload = {
	/** The package on offer, in plan-creation terms. */
	name: string;
	credits: number;
	price_usd: number;
	/** Why this package: the math the agent quoted (burn rate, days to empty). */
	reasoning: string;
	/** Needs the customer stated during negotiation, tracked by the agent. */
	customer_needs?: string[];
	/** For topup_authorization: the catalog pack the agent wants to buy. */
	product_id?: string;
	/** Months of runway the package buys at the current burn rate. */
	projected_months?: number;
};

export type AgentProposalMessage = {
	role: "customer" | "agent";
	content: string;
	at: number;
};

export const agentProposals = pgTable("agent_proposals", {
	id: text("id").primaryKey().notNull(),
	org_id: text("org_id").notNull(),
	env: text("env").notNull(),
	internal_customer_id: text("internal_customer_id").notNull(),
	customer_id: text("customer_id").notNull(),
	kind: text("kind").$type<AgentProposalKind>().notNull(),
	status: text("status").$type<AgentProposalStatus>().notNull(),
	payload: jsonb("payload").$type<AgentProposalPayload>().notNull(),
	conversation: jsonb("conversation").$type<AgentProposalMessage[]>(),
	plan_id: text("plan_id"),
	created_at: numeric({ mode: "number" }).notNull(),
	decided_at: timestamp("decided_at", { withTimezone: true }),
});

export type DbAgentProposal = typeof agentProposals.$inferSelect;
export type InsertDbAgentProposal = typeof agentProposals.$inferInsert;
