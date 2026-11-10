import { expect, test } from "bun:test";
import type { TrackDeduction } from "@autumn/shared";
import { contexts } from "@tests/utils/fixtures/db/contexts.js";
import { initEvent } from "@/internal/balances/events/initEvent.js";

const deduction = (value: number): TrackDeduction =>
	({
		balance_id: "cus_ent_1",
		feature_id: "ai_tokens",
		plan_id: "pro",
		reset: null,
		value,
	}) as TrackDeduction;

const buildEvent = ({
	value,
	deductions,
}: {
	value: number;
	deductions?: TrackDeduction[];
}) =>
	initEvent({
		ctx: contexts.create({}),
		eventInfo: {
			event_name: "ai_tokens",
			value,
			properties: { cost: value },
		},
		internalCustomerId: "cus_internal",
		customerId: "demo-customer",
		deductions,
	});

test("a fully charged event records the requested amount", () => {
	const event = buildEvent({ value: 5, deductions: [deduction(5)] });
	expect(event.value).toBe(5);
});

test("a capped event records what was charged, not what was requested", () => {
	// The customer had 100 credits and the call was worth 360: the deduction
	// stops at their balance, so the ledger records 100 -- the usage that
	// produced it stays in the properties.
	const event = buildEvent({ value: 360, deductions: [deduction(100)] });
	expect(event.value).toBe(100);
	expect(event.properties?.cost).toBe(360);
});

test("an event with no deductions records the requested amount", () => {
	const event = buildEvent({ value: 7 });
	expect(event.value).toBe(7);
});
