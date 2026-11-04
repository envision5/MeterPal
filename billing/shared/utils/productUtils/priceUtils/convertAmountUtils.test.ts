import { describe, expect, test } from "bun:test";
import {
	atmnToMinorUnitAmount,
	atmnToMinorUnitAmountDecimal,
	minorUnitToAtmnAmount,
} from "./convertAmountUtils";

describe("atmnToMinorUnitAmount", () => {
	test("two-decimal currencies scale by 100", () => {
		expect(atmnToMinorUnitAmount({ amount: 18.5, currency: "usd" })).toBe(1850);
		expect(atmnToMinorUnitAmount({ amount: 18.5, currency: "eur" })).toBe(1850);
	});

	test("zero-decimal currencies stay whole", () => {
		expect(atmnToMinorUnitAmount({ amount: 1850, currency: "jpy" })).toBe(1850);
	});

	test("three-decimal currencies scale by 1000 and stay divisible by ten", () => {
		expect(atmnToMinorUnitAmount({ amount: 1.234, currency: "bhd" })).toBe(1230);
		expect(atmnToMinorUnitAmount({ amount: 5, currency: "kwd" })).toBe(5000);
		expect(atmnToMinorUnitAmount({ amount: 5.23, currency: "kwd" })).toBe(5230);
	});
});

describe("atmnToMinorUnitAmountDecimal", () => {
	test("scales by the currency factor", () => {
		expect(atmnToMinorUnitAmountDecimal({ amount: 0.05, currency: "usd" })).toBe(
			"5",
		);
		expect(atmnToMinorUnitAmountDecimal({ amount: 0.05, currency: "bhd" })).toBe(
			"50",
		);
		expect(atmnToMinorUnitAmountDecimal({ amount: 50, currency: "jpy" })).toBe(
			"50",
		);
	});
});

describe("minorUnitToAtmnAmount round-trips", () => {
	test("divides out the currency factor", () => {
		expect(minorUnitToAtmnAmount({ amount: 1850, currency: "usd" })).toBe(18.5);
		expect(minorUnitToAtmnAmount({ amount: 1850, currency: "jpy" })).toBe(1850);
		expect(minorUnitToAtmnAmount({ amount: 1230, currency: "bhd" })).toBe(1.23);
	});
});
