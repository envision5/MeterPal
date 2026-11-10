// billing/server/src/internal/salesAgent/sellerMandate.ts
//
// The merchant's standing instruction to the sales agent — the seller-side
// counterpart of `buyerMandate.ts`.
//
// The agent may only ever *select* from what is declared here.  It never
// authors a price, a credit count, or a discount: those are derived from a
// package on the ladder and an authorized coupon.  That is the whole
// guarantee — the model's action space is a closed set of enum values, so a
// "crazy discount" is not a behaviour that has to be discouraged in a prompt,
// it is a value that cannot be expressed.
//
// The shape lives in `@autumn/shared` (models/orgModels/agent/agentConfig) so
// the settings page and the agent execute the same contract.  This module is
// the server-side reader: it turns `organizations.metadata` into a mandate.

import {
	DEFAULT_SELLER_AGENT_MANDATE,
	readAgentConfig,
	type SellerAgentMandate,
	type SellerCoupon,
	type SellerPackage,
} from "@autumn/shared";

export type { SellerAgentMandate, SellerCoupon, SellerPackage };

export { DEFAULT_SELLER_AGENT_MANDATE };

/**
 * The mandate on an org, or the default when none is configured.
 *
 * `metadata` is a TEXT column holding a JSON blob, so a parse failure is a
 * configuration bug — `readAgentConfig` falls back to the default rather than
 * let a malformed mandate widen the agent's authority.
 */
export const readSellerMandate = (
	metadata: string | null | undefined,
): SellerAgentMandate => readAgentConfig(metadata).seller_agent_mandate;
