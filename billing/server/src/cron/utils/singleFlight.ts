import type { Logger } from "@/external/logtail/logtailUtils.js";

const inFlight = new Set<string>();

/** Process-local overlap guard for cron ticks: the scheduler fires on schedule
 *  even while the previous run is still going, and the blue-green slot gate
 *  only de-dupes deploy slots — this keeps a slow tick from piling up on
 *  itself within one process.
 *
 *  Cross-instance safety is enforced separately by the row guards inside the
 *  jobs (conditional status updates, FOR UPDATE claims) — this guard only
 *  prevents self-overlap. */
export const withSingleFlight = async <T>(
	{ name, logger }: { name: string; logger: Logger },
	fn: () => Promise<T>,
): Promise<T | undefined> => {
	if (inFlight.has(name)) {
		logger.info(
			{ type: "cron_tick_overlap_skipped", tick: name },
			`Tick ${name} still in flight, skipping overlapping fire`,
		);
		return undefined;
	}
	inFlight.add(name);
	try {
		return await fn();
	} finally {
		inFlight.delete(name);
	}
};
