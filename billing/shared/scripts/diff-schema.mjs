// Diff two databases' schemas (tables, columns, constraints, indexes).
import pg from "pg";

const a = new pg.Pool({ connectionString: "postgresql://autumn:autumn_dev_only@localhost:5433/autumn" });
const b = new pg.Pool({ connectionString: "postgresql://autumn:autumn_dev_only@localhost:5433/autumn_baseline_test" });

const sig = async (pool) => {
	const c = await pool.connect();
	const q = async (sql) => (await c.query(sql)).rows;
	const tables = await q(`
		SELECT table_schema, table_name, string_agg(column_name || ':' || format_type(a.atttypid, a.atttypmod) || (CASE WHEN a.attnotnull THEN ':NN' ELSE '' END), '|' ORDER BY ordinal_position) AS cols
		FROM information_schema.columns c
		JOIN pg_attribute a ON a.attrelid = format('%s.%s', c.table_schema, c.table_name)::regclass AND a.attname = c.column_name AND a.attnum = c.ordinal_position
		WHERE table_schema NOT IN ('pg_catalog','information_schema','drizzle') AND table_schema NOT LIKE 'pg_%' AND table_schema NOT LIKE 'tinybird_%'
		GROUP BY 1,2 ORDER BY 1,2`);
	const cons = await q(`
		SELECT n.nspname AS schema, rel.relname AS table, c.conname, pg_get_constraintdef(c.oid, true) AS def
		FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
		WHERE n.nspname NOT IN ('pg_catalog','information_schema','drizzle') AND n.nspname NOT LIKE 'pg_%'
		ORDER BY 1,2,3`);
	const idxs = await q(`
		SELECT schemaname AS schema, tablename AS table, indexname, indexdef
		FROM pg_indexes
		WHERE schemaname NOT IN ('pg_catalog','information_schema','drizzle') AND schemaname NOT LIKE 'pg_%'
		ORDER BY 1,2,3`);
	const seqs = await q(`
		SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
		ORDER BY 1,2`);
	c.release();
	return { tables, cons, idxs, seqs };
};

const A = await sig(a);
const B = await sig(b);

const setOf = (rows, key) => new Set(rows.map((r) => JSON.stringify(key(r))));
const diff = (label, aRows, bRows, key) => {
	const A2 = setOf(aRows, key), B2 = setOf(bRows, key);
	const onlyA = [...A2].filter((x) => !B2.has(x));
	const onlyB = [...B2].filter((x) => !A2.has(x));
	console.log(`${label}: live=${aRows.length} baseline=${bRows.length} | only-in-live=${onlyA.length} only-in-baseline=${onlyB.length}`);
	for (const x of onlyA.slice(0, 8)) console.log(`  LIVE-ONLY: ${x.slice(0, 200)}`);
	for (const x of onlyB.slice(0, 8)) console.log(`  BASE-ONLY: ${x.slice(0, 200)}`);
};

diff("TABLES+COLS", A.tables, B.tables, (r) => [r.schema, r.table, r.cols].join("|"));
diff("CONSTRAINTS", A.cons, B.cons, (r) => [r.schema, r.table, r.conname, r.def].join("|"));
diff("INDEXES", A.idxs, B.idxs, (r) => [r.schema, r.table, r.indexname, r.indexdef].join("|"));
diff("SEQUENCES", A.seqs, B.seqs, (r) => [r.schema, r.name].join("|"));

await a.end();
await b.end();
