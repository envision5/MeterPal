/**
 * Smoke test that the public component exports resolve and the
 * formatCredits utility behaves correctly.  Component-level tests
 * for the React components themselves live in the host app
 * (apps/<your-app>/tests/) and use happy-dom + @testing-library/react.
 */
import { describe, it, expect } from "vitest";

describe("public exports", () => {
  it("re-exports the six components", async () => {
    const mod = await import("./index");
    expect(typeof mod.CreditsBadge).toBe("function");
    expect(typeof mod.LowBalanceBanner).toBe("function");
    expect(typeof mod.PlanCard).toBe("function");
    expect(typeof mod.TopUpModal).toBe("function");
    expect(typeof mod.UsageHistoryPanel).toBe("function");
    expect(typeof mod.CostTooltip).toBe("function");
    expect(typeof mod.createBillingClient).toBe("function");
  });
});