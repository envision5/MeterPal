// billing/server/src/internal/balances/walletProjection.ts
//
// The customer's credits, as a number a human is allowed to look at.
//
// WHY THIS EXISTS
// ---------------
// A metered call reserves its worst-case price before the model runs, so two
// concurrent calls cannot both spend the same credits.  The reservation is a
// real deduction from the balance until the call settles, when it is released
// and the true (much smaller) charge is applied.  Read raw, the balance
// therefore LEAPS DOWN at the start of a call and SPRINGS BACK at the end.
//
// The obvious repair is `balance + active_holds`.  It does not work.  The
// balance lives in Redis and is synced to Postgres by one async batcher;
// the hold events are written to Postgres by a different async batcher.  The
// two are never atomic with each other, so there is a ~600ms window at the
// start of every call where the hold is visible but the deduction is not
// (the wallet spikes UP by the hold), and another at the end where the
// release is visible but the refund is not (the wallet dips DOWN by the
// hold).  Measured on a real call: 33.81 -> 40.36 -> 33.81 -> 27.25 ->
// 32.93.  Adding holds to a lagging balance just moves the flicker around.
//
// WHAT IS ACTUALLY STABLE
// -----------------------
// The settled-charge ledger is append-only: a charge event is inserted once,
// never updated, and never removed.  And the total credits a customer has
// been granted changes only on a top-up, a refund or a reset -- never during
// a call.  At any consistent instant these three agree:
//
//     granted = balance + settled_charges + active_holds
//
// So the display number is `granted - settled_charges`.  It never reads a
// reservation, never reads a lagging balance for its current value, and can
// only step DOWN by the exact amount of a charge that really landed.  The
// short windows where the balance and the events disagree make the
// `granted` CANDIDATE wrong, so a new candidate is accepted only after it has
// held steady long enough to be a real grant rather than an in-flight batch.
//
// This is the single source of truth for every surface that shows credits:
// GET /v1/wallet, the demo app's wallet, and the `meterpal.balance_after`
// field on every completion.

import { sql } from "drizzle-orm";
import type { DrizzleCli } from "@/db/initDrizzle.js";

export type WalletSnapshot = {
	/** Spendable right now. Admission control gates on this; holds deducted. */
	balance: number;
	/** Credits reserved by calls in flight (informational). */
	held: number;
	/** WHAT TO SHOW A HUMAN. Steps down only by real, settled charges. */
	settled: number;
	/** Everything granted, for a progress bar's denominator. */
	granted: number;
	/** Sum of the settled charge ledger. */
	used: number;
	/** Calls holding credits right now. */
	held_calls: number;
};

type Anchor = {
	/** Last accepted grant total. */
	granted: number;
	/** The candidate currently being watched, and since when. */
	candidate: number;
	candidateSince: number;
	lastSeen: number;
};

const anchors = new Map<string, Anchor>();

/** How long a new grant total must hold steady before we believe it.
 *  Measured async-batch skew is ~600-800ms; 1.2s clears it with margin. */
const GRANT_SETTLE_MS = 1_200;
/**
 * A brand-new process has no anchor, and its very first read can land inside
 * that same ~600ms skew window.  Founding `granted` on such a sample would
 * publish a number that is too high (or too low) for the whole debounce
 * period -- a visible spike on the first poll after a deploy.  Re-read once
 * after the batchers have caught up.  Only cold reads pay this, once per key.
 */
const COLD_START_SAMPLE_MS = 750;
/** Ignore floating-point dust. */
const EPS = 1e-6;
/** Bound the cache so a long-lived server cannot grow without limit. */
const MAX_ANCHORS = 4_096;
/** How far back to look for an un-released reservation. */
const HOLD_LOOKBACK_MS = 30 * 60 * 1000;

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

const evictStaleAnchors = (now: number) => {
	if (anchors.size <= MAX_ANCHORS) return;
	for (const [key, value] of anchors) {
		if (now - value.lastSeen > 10 * 60 * 1000) anchors.delete(key);
	}
	// Still too many (a genuinely busy tenant): drop the oldest readers.
	while (anchors.size > MAX_ANCHORS) {
		const oldest = anchors.keys().next().value;
		if (oldest === undefined) break;
		anchors.delete(oldest);
	}
};

/**
 * Read the wallet.  Safe to call on every poll and from inside settlement.
 */
export const readWallet = async ({
	db,
	orgId,
	env,
	customerId,
	featureId,
}: {
	db: DrizzleCli;
	orgId: string;
	env: string;
	customerId: string;
	featureId: string;
}): Promise<WalletSnapshot> => {
	const key = `${orgId}:${env}:${customerId}:${featureId}`;
	const windowStart = new Date(Date.now() - HOLD_LOOKBACK_MS).toISOString();

	// One statement reads all three ledgers.  Keeping it as a function lets a
	// cold start sample twice without duplicating the row-shape handling.
	const sample = async () => {
		const result = await db.execute(
			walletQuery({ customerId, featureId, windowStart, orgId, env }),
		);
		const row = (result as any)?.rows?.[0] ?? (result as any)?.[0] ?? {};

		const balance = Number(row.balance ?? 0);
		// A release whose hold fell outside the lookback leaves a negative
		// sum; that is noise, not a reservation held against the customer.
		const held = Math.max(0, Number(row.held ?? 0));
		const used = Math.max(0, Number(row.used ?? 0));
		return {
			balance,
			held,
			used,
			held_calls: Number(row.held_calls ?? 0),
			candidate: balance + used + held,
		};
	};

	let snap = await sample();
	let anchor = anchors.get(key);

	if (!anchor) {
		// Cold start: let the balance and event batchers converge before we
		// decide what this customer was ever granted.  Re-check the map too --
		// a concurrent cold read may have won the race while we waited.
		await new Promise((resolve) => setTimeout(resolve, COLD_START_SAMPLE_MS));
		snap = await sample();
		anchor = anchors.get(key);
		if (!anchor) {
			const now = Date.now();
			anchor = {
				granted: snap.candidate,
				candidate: snap.candidate,
				candidateSince: now,
				lastSeen: now,
			};
			anchors.set(key, anchor);
			evictStaleAnchors(now);
		}
	}

	const candidate = snap.candidate;
	const now = Date.now();
	anchor.lastSeen = now;
	if (Math.abs(candidate - anchor.candidate) > EPS) {
		anchor.candidate = candidate;
		anchor.candidateSince = now;
	}
	if (
		Math.abs(anchor.granted - anchor.candidate) > EPS &&
		now - anchor.candidateSince >= GRANT_SETTLE_MS
	) {
		// A real top-up / refund / reset.  A reservation crossing an
		// async batch boundary never holds one value this long.
		anchor.granted = anchor.candidate;
	}

	const granted = anchor.granted;
	// `used` is append-only and non-decreasing, so `settled` is monotonic
	// between grants.  This is the whole point.
	const settled = Math.max(0, granted - snap.used);

	return {
		balance: round(snap.balance),
		held: round(snap.held),
		settled: round(settled),
		granted: round(granted),
		used: round(snap.used),
		held_calls: snap.held_calls,
	};
};

/**
 * One statement, three ledgers:
 *   - spendable entitlement rows (what admission control reads)
 *   - unsettled hold events (+ hold / - release, netting to zero at rest)
 *   - settled charge events (the append-only bill)
 */
const walletQuery = ({
	customerId,
	featureId,
	windowStart,
	orgId,
	env,
}: {
	customerId: string;
	featureId: string;
	windowStart: string;
	orgId: string;
	env: string;
}) => {
	// drizzle's `sql` template keeps every value parameterised.
	return sql`
		with spendable as (
			select coalesce(sum(ce.balance), 0) as balance
			from customer_entitlements ce
			join features f on f.internal_id = ce.internal_feature_id
			join customers c on c.internal_id = ce.internal_customer_id
			left join customer_products cp on cp.id = ce.customer_product_id
			where c.id = ${customerId}
				and c.org_id = ${orgId}
				and c.env = ${env}
				and f.id = ${featureId}
				and ce.expired is not true
				and (ce.customer_product_id is null or cp.status = 'active')
		),
		holds as (
			select
				coalesce(sum(e.value), 0) as held,
				count(*) filter (where e.value > 0)
					- count(*) filter (where e.value < 0) as held_calls
			from events e
			where e.org_id = ${orgId}
				and e.env = ${env}
				and e.customer_id = ${customerId}
				and e.event_name = ${featureId}
				and e.idempotency_key is null
				and e."timestamp" >= ${windowStart}
		),
		charges as (
			select coalesce(sum(e.value), 0) as used
			from events e
			where e.org_id = ${orgId}
				and e.env = ${env}
				and e.customer_id = ${customerId}
				and e.event_name = ${featureId}
				and e.idempotency_key is not null
		)
		select
			spendable.balance as balance,
			holds.held as held,
			holds.held_calls as held_calls,
			charges.used as used
		from spendable, holds, charges
	`;
};
