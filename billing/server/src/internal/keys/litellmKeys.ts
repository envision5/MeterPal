// autumn/server/src/internal/keys/litellmKeys.ts
//
// Provisioning handler for the LiteLLM ↔ Autumn bridge.
// Called from event triggers on subscription lifecycle changes.
//
// Security:
//   - LiteLLM master key read from env, never logged.
//   - Customer virtual keys stored in Postgres; full key never returned to clients.
//   - Key hash (SHA-256) stored in bridge_audit_log for forensics.
//   - Every operation is idempotent (key already present → update only).
//
// Usage:
//   await provisionLitellmKey(ctx, { customerId, planKey });
//   await blockLitellmKey(ctx, customerId);

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { parse } from "dotenv";
import { bridgeAuditLog, customers } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { logger } from "@/external/logtail/logtailUtils.js";

// The LiteLLM master key has to be the SAME value for the gateway and this
// server.  gateway/.env is the canonical source: the gateway process reads
// that file at startup, so a key read from it is guaranteed to match and
// there is only ever one copy of the secret.  A second copy in this
// server's .env is exactly how the two drifted apart before.
//
// The environment still wins, which is how a deployed instance supplies it.
// The file is a LOCAL-DEV fallback only.
let gatewayEnvCache: Record<string, string> | null = null;

function gatewayEnv(): Record<string, string> {
  if (gatewayEnvCache) return gatewayEnvCache;
  const path =
    process.env.LITELLM_ENV_FILE ??
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "..",
      "gateway",
      ".env",
    );
  gatewayEnvCache = existsSync(path) ? parse(readFileSync(path)) : {};
  return gatewayEnvCache;
}

// Read lazily: webhook handlers import this module dynamically, and a
// missing bridge config must fail that one operation — not module load.
function litellmBase(): string {
  return required("LITELLM_BASE_URL");
}

function litellmMasterKey(): string {
  return required("LITELLM_MASTER_KEY");
}

// Plan-key → USD budget. Mirrored from plan.md. Keep in sync with the
// merchant dashboard's plan definitions; this table is the fallback when
// the plan metadata is unavailable.
const LITELLM_BUDGET_PER_PLAN: Record<string, number> = {
  free: 5,
  pro: 20,
  pro_plus: 60,
  ultra: 200,
};

const LITELLM_BUDGET_DURATION = "30d";

function required(name: string): string {
  const v = process.env[name] ?? gatewayEnv()[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

async function findVirtualKey(
  ctx: AutumnContext,
  customerId: string,
): Promise<string | null> {
  const [row] = await ctx.db
    .select({ litellmVirtualKey: customers.litellm_virtual_key })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return row?.litellmVirtualKey ?? null;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function litellmFetch(
  path: string,
  body: Record<string, unknown> | null,
  method: "GET" | "POST" = "POST",
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${litellmBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${litellmMasterKey()}`,
      "Content-Type": "application/json",
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/**
 * LiteLLM key aliases are unique across all keys, so minting a second key for
 * the same alias is rejected with a 400.  That happens whenever the MeterPal
 * row loses its key while LiteLLM still holds one under the same alias — e.g.
 * the customer was deleted and recreated with the same id.
 */
function isDuplicateKeyAlias(body: any): boolean {
  const message = String(
    body?.error?.message ?? body?.message ?? body?.error ?? "",
  );
  return /already exists/i.test(message) && /alias/i.test(message);
}

/**
 * Removes the LiteLLM keys registered under an alias.
 *
 * LiteLLM never returns a full key after creation (it is masked in every
 * response), so an orphaned key cannot be adopted — it has to be deleted
 * before a fresh one can be minted.
 */
async function deleteKeysByAlias(alias: string): Promise<number> {
  const list = await litellmFetch(
    `/key/list?key_alias=${encodeURIComponent(alias)}`,
    null,
    "GET",
  );
  const hashes = Array.isArray(list.body?.keys)
    ? (list.body.keys as string[])
    : [];
  if (hashes.length === 0) return 0;

  const del = await litellmFetch("/key/delete", { keys: hashes });
  if (del.status >= 400) {
    throw new Error(
      `litellm /key/delete ${del.status}: ${JSON.stringify(del.body)}`,
    );
  }
  return hashes.length;
}

export interface ProvisionArgs {
  customerId: string;
  planKey: string;
  planMaxBudgetUsd?: number;
}

export async function provisionLitellmKey(
  ctx: AutumnContext,
  args: ProvisionArgs,
): Promise<{ key: string; created: boolean } | null> {
  const { customerId, planKey } = args;
  const maxBudget =
    args.planMaxBudgetUsd ?? LITELLM_BUDGET_PER_PLAN[planKey] ?? 5;

  const [existing] = await ctx.db
    .select({ litellmVirtualKey: customers.litellm_virtual_key })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  // Idempotent: if we already have a key, just update its budget
  if (existing?.litellmVirtualKey) {
    const upd = await litellmFetch("/key/update", {
      key: existing.litellmVirtualKey,
      max_budget: maxBudget,
      budget_duration: LITELLM_BUDGET_DURATION,
    });
    if (upd.status >= 400) {
      await audit(ctx, customerId, "update", "system", existing.litellmVirtualKey, null, JSON.stringify(upd.body));
      throw new Error(`litellm /key/update ${upd.status}: ${JSON.stringify(upd.body)}`);
    }
    await audit(ctx, customerId, "update", "system", existing.litellmVirtualKey, { planKey, maxBudget }, null);
    return { key: existing.litellmVirtualKey, created: false };
  }

  const keyAlias = `autumn:${customerId}`;
  const generateBody = {
    user_id: customerId,
    max_budget: maxBudget,
    budget_duration: LITELLM_BUDGET_DURATION,
    key_alias: keyAlias,
    metadata: {
      autumn_customer_id: customerId,
      plan: planKey,
      provisioned_at: new Date().toISOString(),
    },
  };

  let gen = await litellmFetch("/key/generate", generateBody);

  if (gen.status >= 400 && isDuplicateKeyAlias(gen.body)) {
    // The MeterPal row lost its key but LiteLLM still holds one under this
    // alias.  The old key is unreachable (LiteLLM masks it), and aliases are
    // unique, so the orphan has to go before a fresh key can be minted.
    const removed = await deleteKeysByAlias(keyAlias);
    logger.info({
      msg: "litellm: removed an orphaned virtual key with a duplicate alias",
      customerId,
      alias: keyAlias,
      removed,
    });
    gen = await litellmFetch("/key/generate", generateBody);
  }

  if (gen.status >= 400 || !gen.body?.key) {
    await audit(ctx, customerId, "provision", "system", "", { planKey }, JSON.stringify(gen.body));
    throw new Error(`litellm /key/generate ${gen.status}: ${JSON.stringify(gen.body)}`);
  }

  await ctx.db
    .update(customers)
    .set({ litellm_virtual_key: gen.body.key })
    .where(eq(customers.id, customerId));

  await audit(ctx, customerId, "provision", "system", gen.body.key, { planKey, maxBudget }, null);
  return { key: gen.body.key, created: true };
}

export async function blockLitellmKey(ctx: AutumnContext, customerId: string): Promise<void> {
  const key = await findVirtualKey(ctx, customerId);
  if (!key) return;

  const res = await litellmFetch("/key/block", { key });
  if (res.status >= 400) {
    await audit(ctx, customerId, "block", "system", key, null, JSON.stringify(res.body));
    throw new Error(`litellm /key/block ${res.status}: ${JSON.stringify(res.body)}`);
  }
  await audit(ctx, customerId, "block", "system", key, null, null);
}

export async function unblockLitellmKey(ctx: AutumnContext, customerId: string): Promise<void> {
  const key = await findVirtualKey(ctx, customerId);
  if (!key) return;
  const res = await litellmFetch("/key/unblock", { key });
  if (res.status >= 400) {
    await audit(ctx, customerId, "unblock", "system", key, null, JSON.stringify(res.body));
    throw new Error(`litellm /key/unblock ${res.status}: ${JSON.stringify(res.body)}`);
  }
  await audit(ctx, customerId, "unblock", "system", key, null, null);
}

async function audit(
  ctx: AutumnContext,
  customerId: string,
  action: "provision" | "update" | "block" | "unblock" | "sync_failure",
  actor: string,
  key: string,
  metadata: Record<string, unknown> | null,
  error: string | null,
): Promise<void> {
  try {
    await ctx.db.insert(bridgeAuditLog).values({
      customer_id: customerId,
      action,
      actor,
      litellm_key_hash: key ? hashKey(key) : "",
      metadata: metadata ?? null,
      error: error ?? null,
    });
  } catch (e) {
    logger.error({ msg: "bridge_audit_log insert failed", customerId, action, err: String(e) });
  }
}