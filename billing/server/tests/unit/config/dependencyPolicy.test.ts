/**
 * DEP_FAILURE_POLICY parsing and the strict-mode error/body shapes.
 */
import { expect, test } from "bun:test";
import { RecaseError } from "@autumn/shared";
import {
	dependencyUnavailableBody,
	dependencyUnavailableError,
	getDependencyFailurePolicy,
	isDepFailClosed,
} from "@/internal/misc/dependencyPolicy/dependencyPolicy.js";

const POLICY_ENV = "DEP_FAILURE_POLICY";

const withPolicy = (value: string | undefined, run: () => void) => {
	const original = process.env[POLICY_ENV];
	if (value === undefined) delete process.env[POLICY_ENV];
	else process.env[POLICY_ENV] = value;
	try {
		run();
	} finally {
		if (original === undefined) delete process.env[POLICY_ENV];
		else process.env[POLICY_ENV] = original;
	}
};

test("dependency policy: unset env defaults to fail_open", () => {
	withPolicy(undefined, () => {
		expect(getDependencyFailurePolicy()).toBe("fail_open");
		expect(isDepFailClosed()).toBe(false);
	});
});

test("dependency policy: explicit fail_open and garbage values fall back to fail_open", () => {
	withPolicy("fail_open", () => {
		expect(getDependencyFailurePolicy()).toBe("fail_open");
	});
	withPolicy("FAIL_CLOSED", () => {
		// exact match required — an unknown value must never silently harden
		expect(getDependencyFailurePolicy()).toBe("fail_open");
	});
});

test("dependency policy: fail_closed opts in", () => {
	withPolicy("fail_closed", () => {
		expect(getDependencyFailurePolicy()).toBe("fail_closed");
		expect(isDepFailClosed()).toBe(true);
	});
});

test("dependencyUnavailableError: RecaseError 503 with service_unavailable code and reason", () => {
	const error = dependencyUnavailableError({
		reason: "idempotency_store_unavailable",
		message: "Idempotency store is temporarily unavailable.",
	});
	expect(error).toBeInstanceOf(RecaseError);
	expect(error.statusCode).toBe(503);
	expect(error.code).toBe("service_unavailable");
	expect((error.data as Record<string, unknown>).reason).toBe(
		"idempotency_store_unavailable",
	);
});

test("dependencyUnavailableBody: includes env when present, omits it when absent", () => {
	expect(dependencyUnavailableBody({ ctx: { env: "sandbox" } })).toEqual({
		message: "Service is temporarily unavailable, please retry shortly.",
		code: "service_unavailable",
		env: "sandbox",
	});
	expect(dependencyUnavailableBody({ ctx: {} })).toEqual({
		message: "Service is temporarily unavailable, please retry shortly.",
		code: "service_unavailable",
	});
});
