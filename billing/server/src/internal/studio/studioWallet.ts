// billing/server/src/internal/studio/studioWallet.ts
//
// The wallet that pays for the dashboard's own AI.
//
// Everything agentic in the dashboard -- the Usage Studio assistant, and any
// later console agent -- is the *merchant* working, not their end user.  The
// spend belongs to the merchant, so it is billed to a customer row inside the
// merchant's own org that exists only for this: one wallet per org, holding
// the credits the merchant chose to give their console.
//
// Why a dedicated row rather than billing the merchant's own "org customer"
// or, worse, whichever customer the dashboard happens to be looking at:
//
//   - The customer the dashboard is *about* is data, not a payer.  Billing
//     them means a merchant exploring their own dashboard quietly drains a
//     user's balance -- a leak the user can neither see nor stop, and the
//     opposite of what a metering product should do.
//   - A named wallet shows up in the merchant's customer list, so the spend
//     is visible where they already look for spend, and topping it up is the
//     same action as topping up any other customer.
//   - It is per-org and per-env, so one merchant's console can never draw on
//     another's, and sandbox spend never touches production.
//
// Same shape as the sales agent's wallet (`agent-sales`) and the preview
// wallet (`preview_customer`): a fixed id, created on first use, attached to
// whatever default plan the org sells so it starts with the credits that plan
// includes.

import { customers, type DbCustomer } from "@autumn/shared";
import { and, eq } from "drizzle-orm";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { createCustomerWithDefaults } from "@/internal/customers/actions/createWithDefaults/createCustomerWithDefaults.js";

/** The console wallet's id. Fixed, so a merchant can find and top it up. */
export const STUDIO_WALLET_ID = "meterpal-console";
export const STUDIO_WALLET_NAME = "MeterPal Console";
export const STUDIO_WALLET_EMAIL = "console@meterpal.local";

/**
 * The console wallet if it exists, without creating it.
 *
 * Page loads use this: reading the balance must not provision a customer, or
 * simply opening the studio would create a wallet in every org that never
 * asks the assistant anything.
 */
export const findStudioWallet = async ({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<(DbCustomer & { id: string }) | null> => {
	const existing = await ctx.db.query.customers.findFirst({
		where: and(
			eq(customers.org_id, ctx.org.id),
			eq(customers.env, ctx.env),
			eq(customers.id, STUDIO_WALLET_ID),
		),
	});

	return (existing?.id as string)
		? (existing as DbCustomer & { id: string })
		: null;
};

/**
 * The merchant's console wallet, created on first use.
 *
 * Idempotent: `createCustomerWithDefaults` returns the existing row when the
 * id is already taken, so a second turn is a read.  The row is created inside
 * the caller's org and env -- `ctx` is already scoped to both -- which is
 * what keeps one merchant's console out of another's.
 */
export const ensureStudioWallet = async ({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<DbCustomer & { id: string }> => {
	const existing = await findStudioWallet({ ctx });
	if (existing) return existing;

	const created = await createCustomerWithDefaults({
		ctx,
		customerId: STUDIO_WALLET_ID,
		customerData: {
			name: STUDIO_WALLET_NAME,
			email: STUDIO_WALLET_EMAIL,
		},
	});

	// `createCustomerWithDefaults` returns the public customer shape; the
	// inference path needs the row (virtual key, internal id).
	const row = await ctx.db.query.customers.findFirst({
		where: and(
			eq(customers.org_id, ctx.org.id),
			eq(customers.env, ctx.env),
			eq(customers.id, (created as { id?: string })?.id ?? STUDIO_WALLET_ID),
		),
	});

	if (!row?.id) {
		throw new Error(
			`Could not provision the console wallet (${STUDIO_WALLET_ID}) for org ${ctx.org.id}`,
		);
	}

	return row as DbCustomer & { id: string };
};
