// demo-app/src/paywallState.ts
//
// When is a 402 no longer true?
//
// The demo's paywall card is a snapshot of one arithmetic moment — "balance
// 0.20, this call needs 0.66" — and it stays in the thread until something
// takes it out. Nothing used to: the customer paid, the banner said "10
// credits added", the wallet showed 10.00, and the card above it went on
// claiming the call was refused for lack of money, with a button that
// reopened an order that had already been captured.
//
// The rule lives here rather than in the component because it is arithmetic,
// not presentation: the card is stale exactly when the wallet covers what
// the call needed, whatever put the money there.

import type { PaywallData } from "./components/PaywallCard";

/**
 * Does the wallet now cover the call this refusal was about?
 *
 * A refusal that stated a requirement is answered by that number. One that
 * did not only ever claimed "more than your balance", so any increase retires
 * it — the next attempt either runs or produces a fresh card with the real
 * figure, which is a better outcome than a card that cannot say what it wants.
 */
export function paywallResolved(
	paywall: PaywallData,
	balance: number,
): boolean {
	if (typeof paywall.requiredCredits === "number") {
		// The epsilon is for the credits, not the dollars: charges are summed
		// in floating point, and 0.6599999 is "covered" by 0.66.
		return balance >= paywall.requiredCredits - 1e-9;
	}
	if (typeof paywall.balance !== "number") return false;
	return balance > paywall.balance + 1e-9;
}
