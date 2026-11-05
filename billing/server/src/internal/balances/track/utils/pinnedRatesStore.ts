// billing/server/src/internal/balances/track/utils/pinnedRatesStore.ts
//
// Server-side store for the price quote a check issued.
//
// The check pins the org's rates for the request and the settle is supposed
// to bill at exactly those rates.  Before this store the binding was an
// honor system: the settle call carried `pinned_rates` and the server billed
// them verbatim, so anyone holding an org credential could bill arbitrary
// usage at an arbitrary price (0 rates = free usage).  The quote now lives
// HERE, keyed by the check's idempotency key, and the settle reads it back.
//
// Contract:
//   - savePinnedQuote  at check time, whenever pricing resolved and the
//                      caller sent an idempotency key (the bridge always
//                      does: litellm_call_id).
//   - loadPinnedQuote  at settle time.  A stored quote REPLACES whatever the
//                      caller sent (rates AND the billable model id).  No
//                      stored quote means the caller's pinned_rates are
//                      ignored and the charge is computed from the org's
//                      current price sheet.
//
// Keys are org+env scoped and expire after an hour — far past any settle
// (the gateway's own reservation TTL is 15 minutes).

import { logger } from "@/external/logtail/logtailUtils.js";
import { getMiscRedis } from "@/external/redis/miscCache/getMiscRedis.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { CheckPricing } from "@/internal/api/check/resolveCheckPricing.js";

const QUOTE_TTL_SECONDS = 60 * 60;

const quoteKey = ({
	orgId,
	env,
	idempotencyKey,
}: {
	orgId: string;
	env: string;
	idempotencyKey: string;
}): string => `mp_pinned_quote:{${orgId}}:${env}:${idempotencyKey}`;

export type StoredPinnedQuote = {
	pinned_rates: CheckPricing["pinned_rates"];
	model_id: string;
	estimated_cost: number;
};

/** Persist the quote a check issued, for the settle to read back. */
export const savePinnedQuote = async ({
	ctx,
	idempotencyKey,
	pricing,
}: {
	ctx: AutumnContext;
	idempotencyKey: string;
	pricing: CheckPricing;
}): Promise<void> => {
	const payload: StoredPinnedQuote = {
		pinned_rates: pricing.pinned_rates,
		model_id: pricing.model_id,
		estimated_cost: pricing.estimated_cost,
	};
	try {
		await getMiscRedis().set(
			quoteKey({
				orgId: ctx.org.id,
				env: ctx.env,
				idempotencyKey,
			}),
			JSON.stringify(payload),
			"EX",
			QUOTE_TTL_SECONDS,
		);
	} catch (error) {
		// A failed save must not fail the check: the settle will fall back to
		// server-side pricing (and the caller's rates are ignored either way).
		ctx.logger?.warn?.("failed to save pinned rates quote", {
			idempotencyKey,
			error: String(error),
		});
	}
};

/**
 * The quote issued for this settle, or null when the check did not pin one.
 *
 * A returned quote is authoritative: the caller's `pinned_rates` and
 * `model_id` must be ignored in favor of it.
 */
export const loadPinnedQuote = async ({
	ctx,
	idempotencyKey,
}: {
	ctx: AutumnContext;
	idempotencyKey?: string;
}): Promise<StoredPinnedQuote | null> => {
	if (!idempotencyKey) return null;
	try {
		const raw = await getMiscRedis().get(
			quoteKey({
				orgId: ctx.org.id,
				env: ctx.env,
				idempotencyKey,
			}),
		);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as StoredPinnedQuote;
		if (!parsed?.pinned_rates || !parsed?.model_id) return null;
		return parsed;
	} catch (error) {
		ctx.logger?.warn?.("failed to load pinned rates quote", {
			idempotencyKey,
			error: String(error),
		});
		return null;
	}
};

/** Log when the caller's echoed rates were overridden or dropped. */
export const warnQuoteMismatch = ({
	ctx,
	idempotencyKey,
	reason,
}: {
	ctx: AutumnContext;
	idempotencyKey?: string;
	reason: "no_quote" | "replaced_stored";
}): void => {
	ctx.logger?.warn?.("pinned rates from caller not honored", {
		reason,
		idempotencyKey,
		orgId: ctx.org.id,
	});
};
