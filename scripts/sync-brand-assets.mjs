#!/usr/bin/env node
/**
 * Sync the canonical MeterPal brand assets into every front end's public dir.
 *
 * Source of truth: assets/images/
 *   icon.svg       -> meterpal-icon.svg       (the mark / favicon)
 *   icon-white.svg -> meterpal-icon-white.svg (white mark, for dark surfaces)
 *   logo.svg       -> meterpal-logo-color.svg (dark ink, for light surfaces)
 *   logo-white.svg -> meterpal-logo-white.svg (white ink, for dark surfaces)
 *
 * Every file under a public/ dir is generated. Never edit those copies —
 * edit assets/images/ and re-run `node scripts/sync-brand-assets.mjs`.
 * Wired into each app's prebuild/predev, so a re-brand is a one-file change.
 *
 * Usage:
 *   node scripts/sync-brand-assets.mjs           # write missing/stale copies
 *   node scripts/sync-brand-assets.mjs --check   # verify parity, exit 1 if stale
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "assets", "images");

const assets = {
	"meterpal-icon.svg": "icon.svg",
	"meterpal-icon-white.svg": "icon-white.svg",
	"meterpal-logo-color.svg": "logo.svg",
	"meterpal-logo-white.svg": "logo-white.svg",
};

const targets = [
	join(root, "demo-app", "public"),
	join(root, "billing", "vite", "public"),
	join(root, "billing", "apps", "checkout", "public"),
];

for (const src of Object.values(assets)) {
	const from = join(source, src);
	if (!existsSync(from)) {
		throw new Error(`Missing canonical brand asset: ${from}`);
	}
}

const plan = targets.flatMap((dir) =>
	Object.entries(assets).map(([dest, src]) => ({
		from: join(source, src),
		to: join(dir, dest),
	})),
);

// Historic alias: the dashboard favicon and OAuth consent screen used to point
// at /meterpal-logo.svg. Keep a generated copy so old cached URLs still work.
plan.push({
	from: join(source, "icon.svg"),
	to: join(root, "billing", "vite", "public", "meterpal-logo.svg"),
});

const stale = plan.filter(
	({ from, to }) => !existsSync(to) || !readFileSync(from).equals(readFileSync(to)),
);

const relative = (p) => p.slice(root.length + 1).replace(/\\/g, "/");

if (process.argv.includes("--check")) {
	if (stale.length > 0) {
		console.error(`[brand] ${stale.length} stale file(s):`);
		for (const { to } of stale) console.error(`  - ${relative(to)}`);
		process.exit(1);
	}
	console.log(`[brand] ${plan.length} generated files are in sync with assets/images`);
} else {
	for (const { from, to } of stale) {
		mkdirSync(dirname(to), { recursive: true });
		writeFileSync(to, readFileSync(from));
	}
	console.log(
		`[brand] ${stale.length} file(s) updated from assets/images across ${targets.length} public dirs (${plan.length} total)`,
	);
}
