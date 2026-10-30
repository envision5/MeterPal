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
import { eq } from "drizzle-orm";
import { bridgeAuditLog, customers } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { logger } from "@/external/logtail/logtailUtils.js";

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
  const v = process.env[name];
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
    .select({ litellmVirtualKey: customers.litellmVirtualKey })
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
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${litellmBase()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${litellmMasterKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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
    .select({ litellmVirtualKey: customers.litellmVirtualKey })
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

  const gen = await litellmFetch("/key/generate", {
    user_id: customerId,
    max_budget: maxBudget,
    budget_duration: LITELLM_BUDGET_DURATION,
    key_alias: `autumn:${customerId}`,
    metadata: {
      autumn_customer_id: customerId,
      plan: planKey,
      provisioned_at: new Date().toISOString(),
    },
  });

  if (gen.status >= 400 || !gen.body?.key) {
    await audit(ctx, customerId, "provision", "system", "", { planKey }, JSON.stringify(gen.body));
    throw new Error(`litellm /key/generate ${gen.status}: ${JSON.stringify(gen.body)}`);
  }

  await ctx.db
    .update(customers)
    .set({ litellmVirtualKey: gen.body.key })
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
      customerId,
      action,
      actor,
      litellmKeyHash: key ? hashKey(key) : "",
      metadata: metadata ?? null,
      error: error ?? null,
    });
  } catch (e) {
    logger.error({ msg: "bridge_audit_log insert failed", customerId, action, err: String(e) });
  }
}