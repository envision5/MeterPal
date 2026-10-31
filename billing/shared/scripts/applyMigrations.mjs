// billing/shared/scripts/applyMigrations.mjs
//
// Deterministic migration runner for the billing schema.  Applies the SQL
// files listed in drizzle/meta/_journal.json in order, skipping any whose
// md5 hash is already recorded in drizzle.__drizzle_migrations (the same
// journal drizzle-kit uses), so both tools stay interoperable.
//
// Why not `drizzle-kit migrate`?  It exits silently without applying on this
// project's Windows/bun setup; this runner does the same job verifiably and
// prints every applied file.
//
// Usage:  node scripts/applyMigrations.mjs
// Env:    DATABASE_URL (falls back to parsing ../server/.env)

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function loadDatabaseUrl() {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	const envPath = join(root, "..", "server", ".env");
	if (existsSync(envPath)) {
		const m = readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.*)$/m);
		if (m) return m[1].trim();
	}
	throw new Error("DATABASE_URL not set and ../server/.env not found");
}

const pool = new pg.Pool({ connectionString: loadDatabaseUrl() });
const client = await pool.connect();

await client.query(`create schema if not exists drizzle`);
await client.query(`
	create table if not exists drizzle.__drizzle_migrations (
		id serial primary key,
		hash text not null,
		created_at bigint not null
	)
`);
const { rows } = await client.query(
	`select hash from drizzle.__drizzle_migrations order by id`,
);
const applied = new Set(rows.map((r) => r.hash));

const journal = JSON.parse(
	readFileSync(join(root, "drizzle", "meta", "_journal.json"), "utf8"),
);

let appliedCount = 0;
for (const entry of journal.entries) {
	const file = join(root, "drizzle", `${entry.tag}.sql`);
	const sql = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
	const hash = createHash("md5").update(sql).digest("hex");
	if (applied.has(hash)) continue;

	const statements = sql
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean);
	// Run every statement in order, in autocommit — CREATE INDEX CONCURRENTLY
	// cannot run inside a transaction block, and migration files rely on
	// statement order (create → drop → rename chains).
	try {
		for (const stmt of statements) await pool.query(stmt);
	} catch (err) {
		throw new Error(`migration ${entry.tag} failed: ${err.message}`);
	}
	await pool.query(
		`insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
		[hash, Date.now()],
	);
	appliedCount += 1;
	console.log(`applied ${entry.tag}`);
}

console.log(
	appliedCount === 0
		? "migrations: nothing to apply (up to date)"
		: `migrations: applied ${appliedCount} file(s)`,
);
client.release();
await pool.end();
