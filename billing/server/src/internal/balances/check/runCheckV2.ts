import type { CheckResponseV3, ParsedCheckParams } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { CheckDataV2 } from "./checkTypes/CheckDataV2.js";
import { getCheckDataV2 } from "./getCheckDataV2.js";
import { getCheckResponseV2 } from "./getCheckResponseV2.js";
import { runCheckWithTrackV2 } from "./runCheckWithTrackV2.js";

export const runCheckV2 = async ({
	ctx,
	body,
	requiredBalance,
	lockValue,
}: {
	ctx: AutumnContext;
	body: ParsedCheckParams;
	requiredBalance: number;
	lockValue?: number;
}): Promise<{
	checkData: CheckDataV2;
	response: CheckResponseV3;
}> => {
	const checkData = await getCheckDataV2({
		ctx,
		body: body as ParsedCheckParams & { feature_id: string },
		requiredBalance,
	});

	// Two disjoint branches, and the difference matters for concurrency:
	//
	//   send_event / lock  → the check performs a REAL deduction (the priced
	//     hold) through the atomic Redis Lua script, so concurrent reserved
	//     checks serialize per customer and the sum of outstanding holds can
	//     never exceed the balance.
	//
	//   plain check (neither flag) → read-only evaluation of the cached
	//     subject.  This is ADVISORY: two concurrent plain checks can both
	//     pass off the same balance snapshot.  Enforcement therefore lands at
	//     the settle — the subsequent track's reject gate (or cap) against
	//     live Redis state, not at this read.
	//
	// The LiteLLM bridge closes this gap end to end: it requests a lock by
	// default (REQUIRE_LOCK) and refuses to serve an admit that comes back
	// without a reservation id — including the 202 fail-open body, which it
	// flips to allowed=false → 402 (meterpal_billing.py).
	const response =
		body.send_event || body.lock?.enabled
			? await runCheckWithTrackV2({
					ctx,
					body,
					requiredBalance,
					lockValue,
					checkData,
				})
			: await getCheckResponseV2({
					ctx,
					checkData,
					requiredBalance,
					properties: body.properties,
				});

	return {
		checkData,
		response,
	};
};
