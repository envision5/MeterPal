/**
 * getFleetProcessCount env matrix: the primary's pinned SERVER_FLEET_SIZE
 * wins, workers/prod fall back to the resolved fork count, single-process
 * runs get 1.
 */
import { expect, test } from "bun:test";
import { getFleetProcessCount } from "@/utils/memory/forkRecycling/recyclePolicy.js";

const FLEET_ENV = "SERVER_FLEET_SIZE";
const FORK_ENV = "SERVER_FORK_COUNT";
const NODE_ENV = "NODE_ENV";

type EnvSnapshot = Record<string, string | undefined>;

const snapshotEnv = (keys: string[]): EnvSnapshot =>
	Object.fromEntries(keys.map((key) => [key, process.env[key]]));

const restoreEnv = (snapshot: EnvSnapshot) => {
	for (const [key, value] of Object.entries(snapshot)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
};

const withEnv = (values: Record<string, string | undefined>, run: () => void) => {
	const keys = [...Object.keys(values), FLEET_ENV, FORK_ENV, NODE_ENV];
	const snapshot = snapshotEnv(keys);
	try {
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		// The test process is never a cluster worker; pin that deterministically.
		run();
	} finally {
		restoreEnv(snapshot);
	}
};

test("fleet process count: pinned SERVER_FLEET_SIZE always wins", () => {
	withEnv(
		{ [FLEET_ENV]: "3", [FORK_ENV]: "5", [NODE_ENV]: "production" },
		() => {
			expect(getFleetProcessCount()).toBe(3);
		},
	);
});

test("fleet process count: non-numeric pin is ignored", () => {
	withEnv(
		{ [FLEET_ENV]: "abc", [FORK_ENV]: "2", [NODE_ENV]: "production" },
		() => {
			expect(getFleetProcessCount()).toBe(2);
		},
	);
});

test("fleet process count: prod without pin resolves via SERVER_FORK_COUNT with default and cap", () => {
	withEnv({ [NODE_ENV]: "production" }, () => {
		expect(getFleetProcessCount()).toBe(4); // default
	});
	withEnv({ [FORK_ENV]: "2", [NODE_ENV]: "production" }, () => {
		expect(getFleetProcessCount()).toBe(2);
	});
	withEnv({ [FORK_ENV]: "10", [NODE_ENV]: "production" }, () => {
		expect(getFleetProcessCount()).toBe(6); // cap
	});
});

test("fleet process count: single-process (dev/test) without pin returns 1", () => {
	withEnv({ [NODE_ENV]: "test" }, () => {
		expect(getFleetProcessCount()).toBe(1);
	});
	withEnv({ [NODE_ENV]: "development" }, () => {
		expect(getFleetProcessCount()).toBe(1);
	});
});
