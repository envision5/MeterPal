/**
 * Smoke test that the public component exports resolve and the
 * formatCredits utility behaves correctly.  Component-level tests
 * for the React components themselves live in the host app
 * (apps/<your-app>/tests/) and use happy-dom + @testing-library/react.
 */
import { describe, it, expect } from "vitest";
import { currentPlanIdOf } from "./useCurrentPlan";

describe("public exports", () => {
  it("re-exports the six components", async () => {
    const mod = await import("../index");
    expect(typeof mod.CreditsBadge).toBe("function");
    expect(typeof mod.LowBalanceBanner).toBe("function");
    expect(typeof mod.PlanCard).toBe("function");
    expect(typeof mod.TopUpModal).toBe("function");
    expect(typeof mod.UsageHistoryPanel).toBe("function");
    expect(typeof mod.CostTooltip).toBe("function");
    expect(typeof mod.createBillingClient).toBe("function");
		expect(typeof mod.createMeterPalClient).toBe("function");
  });

	it("exports the current-plan hook", async () => {
		const mod = await import("../index");
		expect(typeof mod.useCurrentPlan).toBe("function");
		expect(typeof mod.currentPlanIdOf).toBe("function");
	});
});

describe("currentPlanIdOf", () => {
	it("returns null when the customer has no subscriptions", () => {
		expect(currentPlanIdOf(null)).toBeNull();
		expect(currentPlanIdOf(undefined)).toBeNull();
		expect(currentPlanIdOf({})).toBeNull();
		expect(currentPlanIdOf({ subscriptions: [] })).toBeNull();
	});

	it("reads the plan id off the customer's subscription", () => {
		expect(
			currentPlanIdOf({
				subscriptions: [{ planId: "pro", status: "active" }],
			}),
		).toBe("pro");
	});

	it("prefers the active subscription over an earlier one", () => {
		expect(
			currentPlanIdOf({
				subscriptions: [
					{ planId: "demo-starter", status: "scheduled" },
					{ planId: "pro", status: "active" },
				],
			}),
		).toBe("pro");
	});

	it("falls back to the first subscription when none is active", () => {
		expect(
			currentPlanIdOf({
				subscriptions: [{ planId: "demo-starter", status: "expired" }],
			}),
		).toBe("demo-starter");
	});

	it("accepts the raw snake_case payload shape", () => {
		expect(
			currentPlanIdOf({
				subscriptions: [{ plan_id: "pro", status: "active" }],
			}),
		).toBe("pro");
	});
});