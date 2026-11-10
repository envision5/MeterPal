// demo-app/agent/watchdog.test.ts — when the buyer agent acts on its own.
// Run: bun test agent/watchdog.test.ts

import { describe, expect, test } from "bun:test";
import { decideAgentAction, initialWatchState } from "./watchdog";

const MARKER_AT = 1_700_000_000_000;

const decide = (
	overrides: Partial<Parameters<typeof decideAgentAction>[0]> = {},
	state = initialWatchState(),
) =>
	decideAgentAction({
		balance: 0,
		mandateEnabled: true,
		pendingCheckout: false,
		depletionAt: null,
		state,
		...overrides,
	});

describe("decideAgentAction", () => {
	test("fires when the core records that the wallet emptied", () => {
		const decision = decide({ depletionAt: MARKER_AT });
		expect(decision.action).toBe("fire");
		expect(decision.state.fired).toBe(true);
		expect(decision.state.actedOnDepletionAt).toBe(MARKER_AT);
	});

	test("fires on an observed drop from positive to zero", () => {
		const decision = decide({}, { ...initialWatchState(), lastBalance: 25 });
		expect(decision.action).toBe("fire");
	});

	test("waits while the wallet still has credits", () => {
		const decision = decide({ balance: 10, depletionAt: MARKER_AT });
		expect(decision.action).toBe("wait");
		expect(decision.state.fired).toBe(false);
	});

	test("waits without a mandate", () => {
		const decision = decide({ mandateEnabled: false, depletionAt: MARKER_AT });
		expect(decision.action).toBe("wait");
	});

	test("waits while a checkout is already open", () => {
		const decision = decide({ pendingCheckout: true, depletionAt: MARKER_AT });
		expect(decision.action).toBe("wait");
	});

	test("acts once per depletion, not once per poll", () => {
		const first = decide({ depletionAt: MARKER_AT });
		expect(first.action).toBe("fire");

		const second = decide({ depletionAt: MARKER_AT }, first.state);
		expect(second.action).toBe("wait");
		expect(second.reason).toContain("already acted");
	});

	test("a marker that lands after the agent already fired does not fire twice", () => {
		// The agent saw the balance empty before the core's marker landed.
		const first = decide({}, { ...initialWatchState(), lastBalance: 25 });
		expect(first.action).toBe("fire");

		const second = decide({ depletionAt: MARKER_AT }, first.state);
		expect(second.action).toBe("wait");
	});

	test("a topped-up wallet starts a fresh episode", () => {
		const depleted = decide({ depletionAt: MARKER_AT });
		const recovered = decide(
			{ balance: 100, depletionAt: MARKER_AT },
			depleted.state,
		);
		expect(recovered.action).toBe("wait");
		expect(recovered.state.fired).toBe(false);

		const next = decide(
			{ depletionAt: MARKER_AT + 1000 },
			recovered.state,
		);
		expect(next.action).toBe("fire");
	});
});
