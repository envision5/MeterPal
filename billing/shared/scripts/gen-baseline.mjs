// Generate a single-file baseline schema DDL from the live migrated DB.
import pg from "pg";

const pool = new pg.Pool({
	connectionString: "postgresql://autumn:autumn_dev_only@localhost:5433/autumn",
});
const c = await pool.connect();

const q = async (sql) => (await c.query(sql)).rows;

// Extensions first (trgm indexes depend on pg_trgm)
let fkOut = "";
let out = `-- MeterPal baseline schema.
-- Single-file baseline replacing the historical migration ledger.
-- Generated from the post-removal schema; safe to replay on a fresh database.
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
`;

// Enums
const enums = await q(`
	SELECT n.nspname AS schema, t.typname AS name,
		array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
	FROM pg_type t
	JOIN pg_enum e ON e.enumtypid = t.oid
	JOIN pg_namespace n ON n.oid = t.typnamespace
	GROUP BY 1, 2 ORDER BY 1, 2`);
for (const e of enums) {
	const vals = e.labels.map((l) => `'${l}'`).join(", ");
	out += `\n--> statement-breakpoint\nDO $$ BEGIN\n\tCREATE TYPE "${e.schema}"."${e.name}" AS ENUM (${vals});\nEXCEPTION\n\tWHEN duplicate_object THEN null;\nEND $$;`;
}

// Schemas
out += `
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS leaf;`;

// Sequences (serial-backed defaults reference these)
const seqs = await q(`
	SELECT n.nspname AS schema, c.relname AS name,
		format_type(seq.seqtypid, NULL) AS typ
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	JOIN pg_sequence seq ON seq.seqrelid = c.oid
	WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog','information_schema')
	ORDER BY n.nspname, c.relname`);
for (const sq of seqs) {
	out += `
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "${sq.schema}"."${sq.name}" AS ${sq.typ};`;
}

// Tables
const schemas = (
	await q(
		`SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','drizzle') AND nspname NOT LIKE 'pg_%'`,
	)
).map((r) => r.nspname);

for (const schema of schemas) {
	const tables = await q(
		`SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' ORDER BY tablename`,
	);
	for (const t of tables) {
		const name = `"${schema}"."${t.tablename}"`;
		const cols = await q(
			`SELECT column_name, data_type, udt_name, character_maximum_length, numeric_precision, numeric_scale,
				is_nullable, column_default, collation_name
			FROM information_schema.columns
			WHERE table_schema = '${schema}' AND table_name = '${t.tablename}'
			ORDER BY ordinal_position`,
		);
		const colDefs = [];
		for (const col of cols) {
			let type;
			if (col.data_type === "ARRAY") {
				const el = await q(
					`SELECT t.typelem::regtype::text AS elem,
						(SELECT n.nspname FROM pg_namespace n JOIN pg_type et ON et.typnamespace = n.oid WHERE et.oid = t.typelem) AS ns
					FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
					WHERE a.attrelid = '${schema}.${t.tablename}'::regclass AND a.attname = '${col.column_name}'`,
				);
				if (el.length) {
					const elemNs = el[0].ns;
					const elem = elemNs === "pg_catalog"
						? el[0].elem.toUpperCase()
						: `"${el[0].elem}"`;
					type = `${elem}[]`;
				} else {
					type = "TEXT[]";
				}
			} else if (col.data_type === "USER-DEFINED") {
				type = `"${col.udt_name}"`;
			} else if (col.data_type === "character varying") {
				type = col.character_maximum_length
					? `VARCHAR(${col.character_maximum_length})`
					: "TEXT";
			} else if (col.data_type === "numeric") {
				type =
					col.numeric_precision != null
						? `NUMERIC(${col.numeric_precision},${col.numeric_scale ?? 0})`
						: "NUMERIC";
			} else if (col.data_type === "timestamp with time zone") {
				type = "TIMESTAMPTZ";
			} else if (col.data_type === "timestamp without time zone") {
				type = "TIMESTAMP";
			} else if (col.data_type === "double precision") {
				type = "DOUBLE PRECISION";
			} else if (col.data_type === "real") {
				type = "REAL";
			} else {
				type = col.data_type.toUpperCase();
			}
			let def = `    "${col.column_name}" ${type}`;
			if (col.collation_name) def += ` COLLATE "${col.collation_name}"`;
			if (col.is_nullable === "NO") def += " NOT NULL";
			if (col.column_default !== null)
				def += ` DEFAULT ${col.column_default}`;
			colDefs.push(def);
		}
		out += `\n--> statement-breakpoint\nCREATE TABLE IF NOT EXISTS ${name} (\n${colDefs.join(",\n")}\n);`;

		// Constraints (PK, unique, check inline; FK collected for a second pass)
		const cons = await q(
			`SELECT conname, pg_get_constraintdef(c.oid, true) AS def, c.contype
			FROM pg_constraint c
			JOIN pg_class rel ON rel.oid = c.conrelid
			JOIN pg_namespace n ON n.oid = rel.relnamespace
			WHERE n.nspname = '${schema}' AND rel.relname = '${t.tablename}'
			ORDER BY c.contype, conname`,
		);
		for (const con of cons) {
			const defStr = con.def;
			let sql;
			if (con.contype === "p") {
				sql = `ALTER TABLE ${name} ADD CONSTRAINT "${con.conname}" ${defStr};`;
			} else if (con.contype === "u") {
				sql = `ALTER TABLE ${name} ADD CONSTRAINT "${con.conname}" ${defStr};`;
			} else if (con.contype === "f") {
				fkOut += `
--> statement-breakpoint
ALTER TABLE ${name} ADD CONSTRAINT "${con.conname}" ${defStr};`;
				continue;
			} else if (con.contype === "c") {
				sql = `ALTER TABLE ${name} ADD CONSTRAINT "${con.conname}" ${defStr};`;
			} else {
				continue;
			}
			sql = sql.replace(
				/ALTER TABLE ONLY /,
				`ALTER TABLE ${name} `,
			).replace(/ADD CONSTRAINT /, "ADD CONSTRAINT ");
			out += `\n--> statement-breakpoint\n${sql}`;
		}

		// Indexes (skip constraint-backed duplicates; keep all explicit indexes)
		const consForSkip = cons.map((cn) => cn.conname);
		const idxs = await q(
			`SELECT indexdef FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = '${t.tablename}' ORDER BY indexname`,
		);
		for (const ix of idxs) {
			let def = ix.indexdef;
			// Skip auto-created constraint indexes (constraints already added)
			const nameMatch = def.match(/^CREATE (?:UNIQUE )?INDEX "?([^"\s]+)"? ON/);
			if (nameMatch && consForSkip.includes(nameMatch[1])) continue;
			// Replace NOT VALID name quoting already fine. Convert CREATE INDEX/UNIQUE INDEX.
			out += `\n--> statement-breakpoint\n${def.replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ")}`;
		}

		// RLS
		const rls = await q(
			`SELECT relrowsecurity FROM pg_class WHERE oid = '${schema}.${t.tablename}'::regclass`,
		);
		if (rls.length && rls[0].relrowsecurity) {
			out += `\n--> statement-breakpoint\nALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;`;
		}
	}
}

out += fkOut;

c.release();
await pool.end();

import { writeFileSync } from "node:fs";
writeFileSync(
	"C:/Users/craig/MeterPal/billing/shared/drizzle/0000_meterpal_init.sql",
	out + "\n",
);
console.log(
	`baseline written: ${(out.match(/CREATE TABLE/g) ?? []).length} tables, ${(out.match(/--> statement-breakpoint/g) ?? []).length} statements`,
);
