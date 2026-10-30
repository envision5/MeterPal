// autumn/server/src/db/migrations/0001_litellm_bridge.ts
//
// Adds the LiteLLM virtual-key column + audit table for the bridge.
//
// Idempotent: safe to re-run. Uses Drizzle's addColumn with ifNotExists-style
// guard via information_schema lookup. Run with `bun run db:migrate`.

import { sql } from "drizzle-orm";
import type { Migration } from "@/db/migrationRunner.js";

export const up: Migration = {
  name: "0001_litellm_bridge",
  run: async (db) => {
    // 1. Add litellm_virtual_key to customers
    await db.execute(sql`
      ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS litellm_virtual_key TEXT;
    `);

    // Index for fast lookup by virtual key (LiteLLM webhook handlers)
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_customers_litellm_vkey
      ON customers (litellm_virtual_key)
      WHERE litellm_virtual_key IS NOT NULL;
    `);

    // 2. Audit table for bridge operations
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS bridge_audit_log (
        id            BIGSERIAL PRIMARY KEY,
        ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        customer_id   TEXT NOT NULL,
        action        TEXT NOT NULL CHECK (action IN ('provision','update','block','unblock','sync_failure')),
        actor         TEXT NOT NULL DEFAULT 'system',  -- 'system' | 'admin:<email>' | 'stripe_webhook'
        litellm_key_hash TEXT NOT NULL,                -- SHA-256 of the key, never the key itself
        metadata      JSONB,
        error         TEXT
      );
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_bridge_audit_customer_ts
      ON bridge_audit_log (customer_id, ts DESC);
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_bridge_audit_action_ts
      ON bridge_audit_log (action, ts DESC);
    `);

    // 3. Rate-limit tracking table for public endpoints
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS bridge_rate_limits (
        scope         TEXT NOT NULL,          -- 'customer:<id>' | 'ip:<addr>'
        window_start  TIMESTAMPTZ NOT NULL,
        counter       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, window_start)
      );
    `);
  },
};

export const down: Migration = {
  name: "0001_litellm_bridge_down",
  run: async (db) => {
    await db.execute(sql`DROP TABLE IF EXISTS bridge_rate_limits;`);
    await db.execute(sql`DROP TABLE IF EXISTS bridge_audit_log;`);
    await db.execute(sql`DROP INDEX IF EXISTS idx_customers_litellm_vkey;`);
    await db.execute(sql`ALTER TABLE customers DROP COLUMN IF EXISTS litellm_virtual_key;`);
  },
};