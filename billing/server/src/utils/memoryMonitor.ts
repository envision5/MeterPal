/**
 * Periodic memory usage logger for diagnosing memory leaks.
 *
 * Logs heap usage, RSS, external memory, array buffers, and event loop lag every interval.
 * Uses Axiom logger so metrics are queryable via type: "memory_log".
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { logger } from "../external/logtail/logtailUtils.js";

// Event loop lag histogram — samples at 100ms resolution at the C++ level.
// No JS callbacks involved, negligible overhead.
//
// Bun on Windows does not implement monitorEventLoopDelay (it throws
// "Not implemented"), which would crash the server at import time. Fall back
// to a no-op histogram there so the rest of the process can start; lag
// readings are simply unavailable on that runtime.
const lagHistogram = (() => {
	try {
		const histogram = monitorEventLoopDelay({ resolution: 100 });
		histogram.enable();
		return histogram;
	} catch {
		return {
			mean: 0,
			max: 0,
			percentile: () => 0,
			reset: () => {},
		} as unknown as ReturnType<typeof monitorEventLoopDelay>;
	}
})();

/** Get the current mean event loop lag in milliseconds. */
export function getEventLoopLagMs(): number {
	return Math.round((lagHistogram.mean / 1e6) * 10) / 10;
}

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute

let intervalHandle: ReturnType<typeof setInterval> | null = null;

function toMB(bytes: number): number {
	return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function logMemoryUsage(label: string) {
	if (process.env.NODE_ENV === "development") {
		return;
	}

	const mem = process.memoryUsage();

	const lagMeanMs = Math.round((lagHistogram.mean / 1e6) * 10) / 10;
	const lagP99Ms = Math.round((lagHistogram.percentile(99) / 1e6) * 10) / 10;
	const lagMaxMs = Math.round((lagHistogram.max / 1e6) * 10) / 10;
	lagHistogram.reset();

	logger.info(
		`memory_log, rss: ${toMB(mem.rss)}MB, heapUsed: ${toMB(mem.heapUsed)}MB, eventLoopLagP99: ${lagP99Ms}ms, eventLoopLagMax: ${lagMaxMs}ms`,
		{
			type: "memory_log",
			data: {
				label,
				pid: process.pid,
				rssMB: toMB(mem.rss),
				heapUsedMB: toMB(mem.heapUsed),
				heapTotalMB: toMB(mem.heapTotal),
				externalMB: toMB(mem.external),
				arrayBuffersMB: toMB(mem.arrayBuffers),
				nativeGapMB: toMB(mem.rss - mem.heapTotal - mem.external),
				eventLoopLagMeanMs: lagMeanMs,
				eventLoopLagP99Ms: lagP99Ms,
				eventLoopLagMaxMs: lagMaxMs,
			},
		},
	);
}

/**
 * Start periodic memory logging.
 * @param label - identifier for the process (e.g. "server", "worker")
 * @param intervalMs - how often to log (default: 60s)
 */
export function startMemoryMonitor(
	label: string,
	intervalMs = DEFAULT_INTERVAL_MS,
) {
	// Log immediately on start
	logMemoryUsage(label);

	intervalHandle = setInterval(() => {
		logMemoryUsage(label);
	}, intervalMs);

	// Don't prevent process exit
	if (intervalHandle.unref) {
		intervalHandle.unref();
	}
}

export function stopMemoryMonitor() {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
	}
}
