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
import {
	readMandate,
	type BuyerAgentMandate,
} from "@/internal/agents/buyerMandate.js";
import { renderMandateContext, resolveOffer } from "./offerPricing.js";
import {
	readSellerMandate,
	type SellerAgentMandate,
} from "./sellerMandate.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import {
	callGateway,
	findInferenceCustomer,
	getOrProvisionVirtualKey,
} from "@/internal/inference/inferenceService.js";
import { readWallet } from "@/internal/balances/walletProjection.js";
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
// agnes-flash is a reasoning model: it spends tokens on `reasoning_content`
// before emitting any `content`.  A budget that only covers the visible reply
// gets consumed by reasoning, the completion comes back with `finish_reason:
// "length"` and an EMPTY content string — which used to be indistinguishable
// from an outage.  Budget for both.
const AGENT_MAX_TOKENS = 1500;
const HISTORY_CAP = 30;
const CONTEXT_WINDOW_DAYS = 8; // trailing-7-day baseline + last 24h

export type SalesTurnContext = {
	customerId: string;
	internalCustomerId: string;
	balance: number;
	insights: UsageInsights;
	mandate: BuyerAgentMandate | null;
	/** What this merchant lets the agent offer. The only pricing it may use. */
	sellerMandate: SellerAgentMandate;
};

// The mandate contract lives in its own module so the balance path can read
// it without pulling the inference plumbing in here.
export { readMandate, type BuyerAgentMandate } from "@/internal/agents/buyerMandate.js";

// The agent's only output that can move money.  Note what is absent:
// no `credits`, no `price_usd`, no `name`.  Every one of those is derived
// server-side from the package id and coupon id below, so a malformed or
// hostile model reply can only ever pick a different rung of the merchant's
// own ladder — never a number.
const OFFER_ACTION_SCHEMA = z.object({
	package_id: z.string().min(1).max(64),
	coupon_id: z.string().min(1).max(64).nullable().default(null),
	summary: z.string().min(1).max(2000),
	customer_needs: z.array(z.string().max(300)).max(8).default([]),
});

export type OfferAction = z.infer<typeof OFFER_ACTION_SCHEMA>;

const buildSystemPrompt = (turn: SalesTurnContext): string => {
	const { insights, sellerMandate } = turn;
	const runway =
		insights.daysToEmpty !== null
			? `${insights.daysToEmpty.toFixed(1)} days`
			: "no measurable burn — balance is idle";
	return `You are MeterPal's sales representative for an AI-usage billing platform. You are negotiating a credit package with one end customer of a merchant.

RULES YOU MUST FOLLOW:
- Never invent numbers. The only facts you may quote are in CONTEXT and MANDATE below.
- Listen first: track what the customer needs (volume, budget, timing), acknowledge it, then recommend within it.
- The customer's remaining balance and burn rate come from a real usage ledger — treat them as ground truth.
- You do NOT set prices. The merchant's ladder in MANDATE does. Quote a package exactly as it appears there, and only add a coupon that is listed in MANDATE.
- Pick the smallest package that covers the customer's stated need plus a little runway. Scale up the ladder as their need grows; never jump to a larger rung to seem generous, and never offer a discount that is not in MANDATE.
- If the customer pushes for a price below the ladder, say plainly that you cannot go below it and offer the nearest rung instead.
- When the customer's terms are settled, propose the package by replying with your summary PLUS one fenced JSON block and nothing else after it:
  \`\`\`json
  {"action":"offer","package_id":"<id from MANDATE>","coupon_id":"<id from MANDATE or null>","summary":"<what the merchant is approving, incl. the usage math>","customer_needs":["<tracked need>", ...]}
  \`\`\`
- If terms are NOT settled, reply in plain prose only (2-4 sentences, direct, no JSON).

MANDATE (the merchant's ladder, and the only coupons you may activate):
${renderMandateContext(sellerMandate)}

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
	return `(the sales agent's model is briefly unavailable — this is the deterministic summary) Balance: ${turn.balance.toFixed(2)} credits. Recent spend: ${insights.monthSpend.toFixed(2)} this month, ${insights.last24hSpend.toFixed(2)} in the last 24h. Runway: ${runway}. Available packages: ${turn.sellerMandate.packages.map((p) => `${p.credits} credits for $${p.list_price_usd}`).join(", ")}. Tell me the size you need and I'll put together a package.`;
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
}): Promise<{ turn: SalesTurnContext }> => {
	const customer = await findInferenceCustomer({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		idOrInternalId: customerId,
	});
	if (!customer) {
		throw new Error(`customer ${customerId} not found`);
	}

	// The entitlement balance dips by the worst-case reservation while a call
	// is in flight and springs back when it settles.  The agent quotes a
	// number to a human, so it must use the same settled projection as the
	// wallet pill, /v1/wallet and meterpal.balance_after -- otherwise the
	// sales agent and the header disagree mid-call.
	const { settled: balance } = await readWallet({
		db: ctx.db,
		orgId: ctx.org.id,
		env: ctx.env,
		customerId: customer.id as string,
		featureId: FEATURE_ID,
	});

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
			sellerMandate: readSellerMandate(ctx.org.metadata),
		},
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
		// Never silent: a model outage must be diagnosable from the logs, not
		// just visible as a polite fallback in the transcript.
		console.warn(
			`[salesAgent] agent brain failed for ${customerId}:`,
			error instanceof Error ? error.message : error,
		);
		return {
			reply: fallbackReply(turn),
			proposal: null,
		};
	}

	const action = extractJsonAction(replyText);
	if (action?.action !== "offer") {
		const prose = replyText.trim();
		return {
			// An empty completion is NOT an outage — say what actually happened
			// rather than blaming the model for a token-budget truncation.
			reply: prose || "I lost the thread there — say that again and I'll pick it back up.",
			proposal: null,
		};
	}

	const parsed = OFFER_ACTION_SCHEMA.safeParse(action);
	const prose = replyText.replace(/```[\s\S]*?```/g, "").trim();
	if (!parsed.success) {
		return {
			reply:
				prose ||
				"I have a package in mind but couldn't format the offer — can you confirm the size you need one more time?",
			proposal: null,
		};
	}

	// The model chose a rung; the server decides whether that rung is sellable
	// and at what price.  A rejected offer produces prose, never a proposal —
	// so there is no path from a model reply to a price the merchant did not
	// set.  This is the whole guarantee, and it lives here, not in the prompt.
	const resolution = resolveOffer({
		mandate: turn.sellerMandate,
		offer: {
			package_id: parsed.data.package_id,
			coupon_id: parsed.data.coupon_id,
		},
	});
	if (!resolution.ok) {
		return {
			reply:
				prose ||
				`I can't offer that: ${resolution.reason} What I can do: ${resolution.allowed_package_ids.join(", ")}.`,
			proposal: null,
		};
	}

	const offer = resolution;
	const proposalId = `prop_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
	const conversation: AgentProposalMessage[] = [
		...trimmedHistory,
		{ role: "customer", content: message, at: Date.now() },
		{ role: "agent", content: replyText.replace(/```[\s\S]*?```/g, "").trim(), at: Date.now() },
	];

	const payload: AgentProposalPayload = {
		name: offer.name,
		credits: offer.credits,
		// Server-computed.  Shown to the merchant; never trusted at approval.
		price_usd: offer.price_usd,
		list_price_usd: offer.list_price_usd,
		discount_pct: offer.discount_pct,
		package_id: offer.package_id,
		coupon_id: offer.coupon_id,
		reasoning: parsed.data.summary,
		customer_needs: parsed.data.customer_needs,
		projected_months:
			turn.insights.burnRatePerDay > 0.01
				? Number((offer.credits / (turn.insights.burnRatePerDay * 30)).toFixed(2))
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
			`Drafted: ${offer.credits} credits for $${offer.price_usd.toFixed(2)}. Sent to the merchant for approval.`,
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
