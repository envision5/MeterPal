// demo-app/src/paywallState.test.ts — when a 402 card stops being true.
// Run: bun test src/paywallState.test.ts

import { describe, expect, test } from "bun:test";
import { paywallResolved } from "./paywallState";

describe("paywallResolved", () => {
	test("stays put while the wallet is short of the call", () => {
		expect(
			paywallResolved({ balance: 0.2, requiredCredits: 0.66 }, 0.2),
		).toBe(false);
		// A partial top-up is not an answer. 0.50 does not buy a 0.66 call,
		// and retiring the card here would send the customer into a second
		// refusal with nothing to explain it.
		expect(
			paywallResolved({ balance: 0.2, requiredCredits: 0.66 }, 0.5),
		).toBe(false);
		expect(
			paywallResolved({ balance: 0.2, requiredCredits: 0.66 }, 0.65),
		).toBe(false);
	});

	test("retires the moment the wallet covers it", () => {
		expect(
			paywallResolved({ balance: 0.2, requiredCredits: 0.66 }, 0.66),
		).toBe(true);
		expect(
			paywallResolved({ balance: 0.2, requiredCredits: 0.66 }, 10),
		).toBe(true);
	});

	test("a balance that rounds to the requirement counts as covering it", () => {
		// Charges are summed in floating point; 0.6599999999 is the same
		// money as 0.66 and must not leave the card up.
		expect(
			paywallResolved({ balance: 0.2, requiredCredits: 0.66 }, 0.6599999999),
		).toBe(true);
	});

	test("without a stated requirement, any increase retires it", () => {
		// The card could only say "more than your balance"; more balance
		// makes that false.
		expect(paywallResolved({ balance: 0.2 }, 0.2)).toBe(false);
		expect(paywallResolved({ balance: 0.2 }, 0.21)).toBe(true);
	});

	test("no balance and no requirement is not a resolvable card", () => {
		expect(paywallResolved({}, 100)).toBe(false);
		expect(paywallResolved({ balance: 0.2 }, 0)).toBe(false);
	});
});
