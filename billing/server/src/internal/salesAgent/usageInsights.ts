// billing/server/src/internal/salesAgent/usageInsights.ts
//
// The one implementation of spend math for the agentic layer: the sales-rep
// agent's tools, the demo-app's agent panel, and the dashboard's unusual-spend
// section all read from here.  Everything is grounded in the events ledger —
// `value` on an `ai_tokens` event is the credits charged for one call — so a
// projection shown to a customer is always arithmetic over real rows, never a
// model's guess.

import { and, eq, gte, isNotNull } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import { events } from "@autumn/shared";

const DAY_MS = 86_400_000;

export type SpendPoint = { at: number; value: number };

export type SpendAnomaly = {
	flagged: boolean;
	reason: string | null;
	/** Credits spent in the last 24h. */
	last24hSpend: number;
	/** Mean daily credits over the trailing 7 days (excluding the last 24h). */
	baselineDaily: number;
};

export type UsageInsights = {
	/** Credits spent since the first of the current month (calendar, UTC). */
	monthSpend: number;
	/** Credits spent in the last 24h. */
	last24hSpend: number;
	/** Trailing-7-day daily average, excluding the last 24h. */
	baselineDaily: number;
	/** Credits per day the agent projects at: the larger of the two windows. */
	burnRatePerDay: number;
	/** Days until the current balance is empty at burnRatePerDay; null when idle. */
	daysToEmpty: number | null;
	/**
	 * What the projection is extrapolated from.
	 *
	 * A customer whose entire history is one day has no "current burn rate" —
	 * there is no rate, there is one day's spend. Dividing the balance by it
	 * still produces a number (3 credits against $0.03 spent reads as a
	 * 100-day runway), and that number is arithmetically right and
	 * rhetorically wrong: it looks like a forecast when it is a single
	 * sample. Carrying the basis lets the UI say which one it is instead of
	 * printing a confident 94.0 days.
	 */
	runwayBasis: "trailing-week" | "today" | "none";
	anomaly: SpendAnomaly;
};

/** Spend rows for one customer/feature since `sinceMs`, oldest last. */
export const getSpendPoints = async ({
	db,
	orgId,
	env,
	internalCustomerId,
	featureId,
	sinceMs,
}: {
	db: DrizzleCli;
	orgId: string;
	env: string;
	internalCustomerId: string;
	featureId: string;
	sinceMs: number;
}): Promise<SpendPoint[]> => {
	const rows = await db
		.select({ timestamp: events.timestamp, value: events.value })
		.from(events)
		.where(
			and(
				eq(events.internal_customer_id, internalCustomerId),
				eq(events.org_id, orgId),
				eq(events.env, env),
				eq(events.event_name, featureId),
				gte(events.timestamp, new Date(sinceMs)),
				// Only the settled charge counts.  A metered call also writes the
				// check-time reservation and its refund around it, both internal
				// and signed the wrong way to be a cost -- and the reservation
				// stays outstanding for as long as the call runs.  Counting it
				// would make spend read high while a request is in flight, so
				// the number on the customer's screen would jump up and back.
				// The settled event is the one carrying the idempotency key.
				isNotNull(events.idempotency_key),
			),
		)
		.orderBy(events.timestamp);

	return rows.map((row) => ({
		at: row.timestamp ? new Date(row.timestamp).getTime() : 0,
		value: row.value ?? 0,
	}));
};

export const sumSpend = (points: SpendPoint[]): number =>
	points.reduce((total, point) => total + point.value, 0);

export const sumSpendSince = (points: SpendPoint[], sinceMs: number): number =>
	sumSpend(points.filter((point) => point.at >= sinceMs));

/** Credits spent in the current calendar month (UTC). */
export const monthStartMs = (nowMs: number): number => {
	const date = new Date(nowMs);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/**
 * The anomaly rule: the last 24 hours cost more than 3× the trailing-7-day
 * daily average (and at least half a credit, so an idle customer's first
 * call never reads as a burst).
 */
export const detectAnomaly = (
	points: SpendPoint[],
	nowMs: number = Date.now(),
): SpendAnomaly => {
	const last24hSpend = sumSpendSince(points, nowMs - DAY_MS);
	const priorWeekSpend = sumSpendSince(points, nowMs - 8 * DAY_MS) - last24hSpend;
	const baselineDaily = priorWeekSpend / 7;

	if (baselineDaily < 0.01) {
		// No baseline yet (fresh customer): a burst is still unusual — someone
		// brand-new spending hard on day one is exactly what a merchant wants
		// flagged.  A single idle first call never trips it.
		const newCustomerBurst = last24hSpend >= 2;
		return {
			flagged: newCustomerBurst,
			reason: newCustomerBurst
				? `New customer spent ${last24hSpend.toFixed(2)} credits in their first 24h — no baseline yet, but that pace is worth watching.`
				: null,
			last24hSpend,
			baselineDaily,
		};
	}

	const flagged = last24hSpend > 3 * baselineDaily && last24hSpend >= 0.5;
	return {
		flagged,
		reason: flagged
			? `Spent ${last24hSpend.toFixed(2)} credits in the last 24h — ${(
					last24hSpend / baselineDaily
				).toFixed(1)}× the trailing 7-day daily average (${baselineDaily.toFixed(2)}).`
			: null,
		last24hSpend,
		baselineDaily,
	};
};

export const computeInsights = ({
	points,
	balance,
	nowMs = Date.now(),
}: {
	points: SpendPoint[];
	balance: number;
	nowMs?: number;
}): UsageInsights => {
	const last24hSpend = sumSpendSince(points, nowMs - DAY_MS);
	const priorWeekSpend = sumSpendSince(points, nowMs - 8 * DAY_MS) - last24hSpend;
	const baselineDaily = priorWeekSpend / 7;

	// Project at the larger of the recent burst and the steady baseline: a
	// customer mid-burst gets the honest (short) runway, an idle one gets null.
	const burnRatePerDay = Math.max(last24hSpend, baselineDaily);
	const daysToEmpty =
		burnRatePerDay > 0.01 && balance > 0 ? balance / burnRatePerDay : null;

	return {
		monthSpend: sumSpendSince(points, monthStartMs(nowMs)),
		last24hSpend,
		baselineDaily,
		burnRatePerDay,
		daysToEmpty,
		// A trailing week is a rate; a single day is a sample of one.
		runwayBasis:
			daysToEmpty == null
				? "none"
				: baselineDaily > 0.01
					? "trailing-week"
					: "today",
		anomaly: detectAnomaly(points, nowMs),
	};
};
