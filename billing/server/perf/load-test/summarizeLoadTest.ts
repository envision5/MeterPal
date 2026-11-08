/**
 * Turns an Artillery `--output results.json` into a committed markdown
 * evidence summary (request rate, latency percentiles, per-endpoint
 * latencies, status codes).
 *
 * Run: cd server && bun loadtest:report
 * (reads perf/load-test/results/results.json by default; pass a path as the
 * first CLI arg to summarize a different file)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const inPath = process.argv[2] ?? join(__dirname, "results", "results.json");

if (!existsSync(inPath)) {
	console.error(
		`[report] no results file at ${inPath} — run the load test with --output first:\n` +
			`  bun loadtest   (writes perf/load-test/results/results.json)`,
	);
	process.exit(1);
}

/** Artillery v2 summary blocks: { min, max, count?, mean, median, p95, p99 }. */
type Summary = Record<string, number | undefined>;
type ArtilleryData = {
	aggregate?: {
		counters?: Record<string, number | undefined>;
		rates?: Record<string, number | undefined>;
		summaries?: Record<string, Summary>;
		firstCounterAt?: number;
		lastCounterAt?: number;
	};
};

const raw: ArtilleryData = JSON.parse(readFileSync(inPath, "utf-8"));
const { counters = {}, rates = {}, summaries = {} } = raw.aggregate ?? {};

const pick = (key: string) => counters[key];

const fmtLatency = (summary: Summary | undefined) => {
	if (!summary) return "—";
	const ms = (v: number | undefined) =>
		v === undefined ? "—" : `${Math.round(v)}ms`;
	return `${ms(summary.median)} / ${ms(summary.p95)} / ${ms(summary.p99)}`;
};

const fmtRate = () => {
	const rate = rates["http.request_rate"];
	return rate === undefined ? "—" : `${Number(rate).toFixed(1)} req/s`;
};

const fmtCodes = () => {
	const codes = Object.entries(counters)
		.filter(([key, value]) => key.startsWith("http.codes.") && (value ?? 0) > 0)
		.map(
			([key, value]) =>
				`${key.replace("http.codes.", "")}: ${(value ?? 0).toLocaleString()}`,
		);
	return codes.length > 0 ? codes.join("  ") : "—";
};

const fmtWindow = () => {
	const { firstCounterAt, lastCounterAt } = raw.aggregate ?? {};
	if (!firstCounterAt || !lastCounterAt) return "—";
	const seconds = ((lastCounterAt - firstCounterAt) / 1000).toFixed(0);
	return `${seconds}s`;
};

// Per-endpoint latency summaries arrive under
// plugins.metrics-by-endpoint.response_time.<path>.
const endpointRows = Object.entries(summaries)
	.filter(([key]) =>
		key.startsWith("plugins.metrics-by-endpoint.response_time."),
	)
	.map(([key, summary]) => ({
		endpoint: key
			.replace("plugins.metrics-by-endpoint.response_time.", "")
			.replace(/\{\{[^}]+\}\}/g, ":id"),
		summary,
	}))
	.sort((a, b) => a.endpoint.localeCompare(b.endpoint));

const lines: string[] = [];
lines.push(`# Load test summary`);
lines.push("");
lines.push(`- Results file: \`${inPath}\``);
lines.push(`- Window: ${fmtWindow()}`);
lines.push("");

if (endpointRows.length > 0) {
	lines.push(`| Endpoint | p50 / p95 / p99 |`);
	lines.push(`|---|---|`);
	for (const row of endpointRows) {
		lines.push(`| ${row.endpoint} | ${fmtLatency(row.summary)} |`);
	}
	lines.push("");
}

lines.push(`## Aggregate`);
lines.push("");
lines.push(`| Metric | Value |`);
lines.push(`|---|---|`);
lines.push(`| Requests | ${(pick("http.requests") ?? 0).toLocaleString()} |`);
lines.push(`| Rate | ${fmtRate()} |`);
lines.push(`| p50 / p95 / p99 | ${fmtLatency(summaries["http.response_time"])} |`);
lines.push(`| Status codes | ${fmtCodes()} |`);
const scenariosCreated = pick("vusers.created") ?? 0;
const scenariosFailed = pick("vusers.failed") ?? 0;
lines.push(
	`| Scenarios created / failed | ${scenariosCreated.toLocaleString()} / ${scenariosFailed.toLocaleString()} |`,
);
lines.push("");

const outPath = inPath.replace(/\.json$/, ".md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n"));
console.log(`[report] wrote ${outPath}`);
console.log(lines.join("\n"));
