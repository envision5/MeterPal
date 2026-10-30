import { describe, it, expect } from "vitest";
import { formatCredits, cn } from "./utils";

describe("formatCredits", () => {
  it("formats small integers without decimals", () => {
    expect(formatCredits(0)).toBe("0");
    expect(formatCredits(42)).toBe("42");
    expect(formatCredits(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatCredits(1_000)).toBe("1.0k");
    expect(formatCredits(1_247)).toBe("1.2k");
    expect(formatCredits(12_345)).toBe("12.3k");
  });

  it("formats millions with M suffix", () => {
    expect(formatCredits(1_000_000)).toBe("1.0M");
    expect(formatCredits(2_500_000)).toBe("2.5M");
  });

  it("handles negative numbers", () => {
    expect(formatCredits(-1_500)).toBe("-1.5k");
  });

  it("handles non-finite input safely", () => {
    expect(formatCredits(NaN)).toBe("0");
    expect(formatCredits(Infinity)).toBe("0");
  });
});

describe("cn", () => {
  it("merges tailwind classes correctly", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-red-500", false && "text-blue-500")).toBe("text-red-500");
  });
});