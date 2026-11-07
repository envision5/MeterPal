// billing/server/src/internal/salesAgent/engine.ts
//
// The sales-rep agent's brain.  One turn = one agnes-flash call with a
// precomputed context: the customer's real spend math (usageInsights), the
// merchant's catalog packs, and the buyer-agent mandate.  No tool-calling
// API dependency — agnes answers with prose, or with a single fenced JSON
// action when terms have settled.  If the LLM is unreachable the turn
// degrades to a deterministic reply built from the same numbers, so a
// negotiation never dies on a model outage.

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
	agentProposals,
	RecaseError,
	type AgentProposalKind,
	type AgentProposalMessage,
	type AgentProposalPayload,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import {
	callGateway,
	findInferenceCustomer,
	getOrProvisionVirtualKey,
} from "@/internal/inference/inferenceService.js";
import { getApiCustomerByRollout } from "@/internal/customers/actions/getApiCustomerByRollout.js";
import {
	computeInsights,
	getSpendPoints,
	monthStartMs,
	type UsageInsights,
} from "./usageInsights.js";

/** The customer row that meters the agent's own brain (see bootstrap.py). */
export const AGENT_CUSTOMER_ID = "agent-sales";

const FEATURE_ID = "ai_tokens";
const AGNES_MODEL = "agnes-flash";
const AGENT_MAX_TOKENS = 700;
const HISTORY_CAP = 30;
const CONTEXT_WINDOW_DAYS = 8; // trailing-7-day baseline + last 24h

export type SalesTurnContext = {
	customerId: string;
	internalCustomerId: string;
	balance: number;
	insights: UsageInsights;
	mandate: BuyerAgentMandate | null;
};

export type BuyerAgentMandate = {
	enabled: boolean;
	/** Largest single purchase (USD) the buyer agent may initiate itself. */
	max_per_purchase: number;
	/** Calendar-month spend ceiling (USD) beyond which the agent stops. */
	monthly_budget: number;
	/** Purchases up to this price skip the in-app confirmation and go
	 *  straight to PayPal's approval (the human gate on money). */
	auto_approve_below: number;
};

export const readMandate = (metadata: Record<string, any> | null | undefined): BuyerAgentMandate | null => {
	const raw = metadata?.buyer_agent_mandate;
	if (!raw || typeof raw !== "object" || raw.enabled !== true) return null;
	const schema = z.object({
		enabled: z.boolean(),
		max_per_purchase: z.number().positive(),
		monthly_budget: z.number().positive(),
		auto_approve_below: z.number().nonnegative(),
	});
	const parsed = schema.safeParse(raw);
	return parsed.success ? parsed.data : null;
};

const DRAFT_ACTION_SCHEMA = z.object({
	credits: z.number().positive(),
	price_usd: z.number().positive(),
	name: z.string().min(1).max(120),
	summary: z.string().min(1).max(2000),
	customer_needs: z.array(z.string().max(300)).max(8).default([]),
});

export type DraftPackageAction = z.infer<typeof DRAFT_ACTION_SCHEMA>;

/** The merchant's one-off packs the agent may quote (matches bootstrap.py). */
const CATALOG_PACKS = [
	{ product_id: "topup_10", credits: 10, price_usd: 10 },
	{ product_id: "topup_50", credits: 50, price_usd: 50 },
	{ product_id: "topup_200", credits: 200, price_usd: 200 },
];

const buildSystemPrompt = (turn: SalesTurnContext): string => {
	const { insights } = turn;
	const runway =
		insights.daysToEmpty !== null
			? `${insights.daysToEmpty.toFixed(1)} days`
			: "no measurable burn — balance is idle";
	return `You are MeterPal's sales representative for an AI-usage billing platform. You are negotiating a custom credit package with one end customer of a merchant.

RULES YOU MUST FOLLOW:
- Never invent numbers. The only facts you may quote are in CONTEXT below.
- Listen first: track what the customer needs (volume, budget, timing), acknowledge it, then negotiate within it.
- The customer's remaining balance and burn rate come from a real usage ledger — treat them as ground truth.
- You may quote these standard packs: ${CATALOG_PACKS.map((p) => `${p.credits} credits for $${p.price_usd}`).join(", ")}.
- When the customer's terms are settled (they agreed on a size and a price), propose the package by replying with your summary PLUS one fenced JSON block and nothing else after it:
  \`\`\`json
  {"action":"draft_package","credits":<number>,"price_usd":<number>,"name":"<short package name>","summary":"<what the merchant is approving, incl. the math>","customer_needs":["<tracked need>", ...]}
  \`\`\`
- Credit prices are 1:1 with USD (10 credits = $10). You may discount modestly for volume (e.g. 100 credits for $85) — the merchant approves or rejects your draft either way.
- If terms are NOT settled, reply in plain prose only (2-4 sentences, direct, no JSON).

CONTEXT (ground truth, ${new Date().toISOString().slice(0, 10)}):
${JSON.stringify(
	{
		balance_credits: Number(turn.balance.toFixed(2)),
		spend_this_month: Number(insights.monthSpend.toFixed(2)),
		last_24h: Number(insights.last24hSpend.toFixed(2)),
		baseline_daily: Number(insights.baselineDaily.toFixed(2)),
		projected_burn_per_day: Number(insights.burnRatePerDay.toFixed(2)),
		days_until_empty: runway,
		unusual_spend_flag: insights.anomaly.flagged ? insights.anomaly.reason : null,
		standard_packs: CATALOG_PACKS,
	},
	null,
	1,
)}`;
};

/** Pull one fenced JSON object out of a model reply, if present. */
export const extractJsonAction = (
	text: string,
): { action: string; [key: string]: unknown } | null => {
	const matches = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)];
	for (const match of matches.reverse()) {
		try {
			const parsed = JSON.parse(match[1]);
			if (parsed && typeof parsed === "object" && "action" in parsed) {
				return parsed as { action: string };
			}
		} catch {
			continue;
		}
	}
	return null;
};

/** Call agnes-flash through the shared gateway — billed to the agent's wallet. */
const callAgentBrain = async ({
	ctx,
	messages,
}: {
	ctx: AutumnContext;
	messages: { role: "system" | "user" | "assistant"; content: string }[];
}): Promise<string> => {
	const agentCustomer = await findInferenceCustomer({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		idOrInternalId: AGENT_CUSTOMER_ID,
	});
	if (!agentCustomer) {
		throw new Error(
			`agent customer ${AGENT_CUSTOMER_ID} does not exist — run demo/bootstrap.py`,
		);
	}
	const virtualKey = await getOrProvisionVirtualKey({
		ctx,
		customer: agentCustomer,
	});
	const response = await callGateway({
		virtualKey,
		callId: crypto.randomUUID(),
		payload: {
			model: AGNES_MODEL,
			messages,
			max_tokens: AGENT_MAX_TOKENS,
			user: AGENT_CUSTOMER_ID,
		},
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`agent brain ${AGNES_MODEL} -> ${response.status}: ${body.slice(0, 300)}`);
	}
	const data = (await response.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	return data.choices?.[0]?.message?.content ?? "";
};

/** The deterministic reply when the model is unavailable — never a dead end. */
const fallbackReply = (turn: SalesTurnContext): string => {
	const { insights } = turn;
	const runway =
		insights.daysToEmpty !== null
			? `${insights.daysToEmpty.toFixed(1)} days at the current burn rate`
			: "no measurable burn yet";
	return `(the sales agent's model is briefly unavailable — this is the deterministic summary) Balance: ${turn.balance.toFixed(2)} credits. Recent spend: ${insights.monthSpend.toFixed(2)} this month, ${insights.last24hSpend.toFixed(2)} in the last 24h. Runway: ${runway}. Standard packs: ${CATALOG_PACKS.map((p) => `${p.credits} credits for $${p.price_usd}`).join(", ")}. Tell me the size you need and I'll put together a package.`;
};

export type SalesTurnResult = {
	reply: string;
	proposal: {
		id: string;
		kind: AgentProposalKind;
		payload: AgentProposalPayload;
	} | null;
};

/** Build the ground-truth context for one customer. */
export const buildTurnContext = async ({
	ctx,
	customerId,
}: {
	ctx: AutumnContext;
	customerId: string;
}): Promise<{ turn: SalesTurnContext; apiCustomer: any }> => {
	const customer = await findInferenceCustomer({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		idOrInternalId: customerId,
	});
	if (!customer) {
		throw new Error(`customer ${customerId} not found`);
	}

	const apiCustomer = await getApiCustomerByRollout({
		ctx,
		customerId: customer.id as string,
		source: "salesAgent.buildTurnContext",
	});
	const balance = apiCustomer?.balances?.[FEATURE_ID]?.remaining ?? 0;

	const nowMs = Date.now();
	const sinceMs = Math.min(monthStartMs(nowMs), nowMs - CONTEXT_WINDOW_DAYS * 86_400_000);
	const points = await getSpendPoints({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		internalCustomerId: customer.internal_id as string,
		featureId: FEATURE_ID,
		sinceMs,
	});

	return {
		turn: {
			customerId: customer.id as string,
			internalCustomerId: customer.internal_id as string,
			balance,
			insights: computeInsights({ points, balance, nowMs }),
			mandate: readMandate(customer.metadata),
		},
		apiCustomer,
	};
};

/** Run one negotiation turn.  History is the client-held conversation so far. */
export const runSalesTurn = async ({
	ctx,
	customerId,
	message,
	history = [],
}: {
	ctx: AutumnContext;
	customerId: string;
	message: string;
	history?: AgentProposalMessage[];
}): Promise<SalesTurnResult> => {
	const { turn } = await buildTurnContext({ ctx, customerId });

	const trimmedHistory = history.slice(-HISTORY_CAP);
	const chatMessages = [
		{ role: "system" as const, content: buildSystemPrompt(turn) },
		...trimmedHistory.map((m) => ({
			role: m.role === "customer" ? ("user" as const) : ("assistant" as const),
			content: m.content,
		})),
		{ role: "user" as const, content: message },
	];

	let replyText: string;
	try {
		replyText = await callAgentBrain({ ctx, messages: chatMessages });
	} catch (error) {
		replyText = fallbackReply(turn);
		return {
			reply: replyText,
			proposal: null,
		};
	}

	const action = extractJsonAction(replyText);
	if (action?.action !== "draft_package") {
		return { reply: replyText.trim() || fallbackReply(turn), proposal: null };
	}

	const parsed = DRAFT_ACTION_SCHEMA.safeParse(action);
	if (!parsed.success) {
		const prose = replyText.replace(/```[\s\S]*?```/g, "").trim();
		return {
			reply:
				prose ||
				"I have a package in mind but couldn't format the draft — can you confirm the size and price one more time?",
			proposal: null,
		};
	}

	const draft = parsed.data;
	const proposalId = `prop_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
	const conversation: AgentProposalMessage[] = [
		...trimmedHistory,
		{ role: "customer", content: message, at: Date.now() },
		{ role: "agent", content: replyText.replace(/```[\s\S]*?```/g, "").trim(), at: Date.now() },
	];

	const payload: AgentProposalPayload = {
		name: draft.name,
		credits: draft.credits,
		price_usd: draft.price_usd,
		reasoning: draft.summary,
		customer_needs: draft.customer_needs,
		projected_months:
			turn.insights.burnRatePerDay > 0.01
				? Number((draft.credits / (turn.insights.burnRatePerDay * 30)).toFixed(2))
				: undefined,
	};

	await ctx.db.insert(agentProposals).values({
		id: proposalId,
		org_id: ctx.org.id,
		env: ctx.env,
		internal_customer_id: turn.internalCustomerId,
		customer_id: turn.customerId,
		kind: "custom_package",
		status: "pending_merchant",
		payload,
		conversation: conversation.slice(-HISTORY_CAP),
		created_at: Date.now(),
	});

	return {
		reply:
			replyText.replace(/```[\s\S]*?```/g, "").trim() ||
			`Drafted: ${draft.credits} credits for $${draft.price_usd}. Sent to the merchant for approval.`,
		proposal: { id: proposalId, kind: "custom_package", payload },
	};
};

/** Fetch one proposal, org+env scoped.  404 via RecaseError when missing. */
export const getProposal = async ({
	ctx,
	proposalId,
}: {
	ctx: AutumnContext;
	proposalId: string;
}) => {
	const proposal = await ctx.db.query.agentProposals.findFirst({
		where: and(
			eq(agentProposals.id, proposalId),
			eq(agentProposals.org_id, ctx.org.id),
			eq(agentProposals.env, ctx.env),
		),
	});
	if (!proposal) {
		throw new RecaseError({
			message: `Proposal ${proposalId} not found`,
			statusCode: 404,
		});
	}
	return proposal;
};

/** The most recent proposal for a customer, newest first (list views). */
export const listProposals = async ({
	ctx,
	customerId,
}: {
	ctx: AutumnContext;
	customerId: string;
}) => {
	return await ctx.db
		.select()
		.from(agentProposals)
		.where(
			and(
				eq(agentProposals.org_id, ctx.org.id),
				eq(agentProposals.env, ctx.env),
				eq(agentProposals.customer_id, customerId),
			),
		)
		.orderBy(desc(agentProposals.created_at))
		.limit(50);
};
