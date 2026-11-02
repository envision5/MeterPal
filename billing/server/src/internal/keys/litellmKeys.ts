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
import { and, eq, isNotNull } from "drizzle-orm";
import {
  AppEnv,
  bridgeAuditLog,
  customers,
  customerProducts,
  servedModels,
} from "@autumn/shared";
import type { DrizzleCli } from "@/db/initDrizzle.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { logger } from "@/external/logtail/logtailUtils.js";
import { litellmBase, litellmMasterKey } from "@/internal/keys/litellmEnv.js";

// The LiteLLM master key has to be the SAME value for the gateway and this
// server.  gateway/.env is the canonical source — see litellmEnv.ts.

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

/**
 * Plan-key -> the customer's own rate limits.
 *
 * These sit on the key, so they protect the merchant from a runaway end
 * user: one customer cannot spend the merchant's whole provider quota.
 */
const LITELLM_RATE_LIMITS_PER_PLAN: Record<
  string,
  { rpm: number; tpm: number }
> = {
  free: { rpm: 20, tpm: 50_000 },
  pro: { rpm: 120, tpm: 400_000 },
  pro_plus: { rpm: 300, tpm: 1_000_000 },
  ultra: { rpm: 600, tpm: 4_000_000 },
};

/**
 * The org's rate limits.
 *
 * These are enforced by the gateway, against a shared Redis counter, so
 * one merchant cannot exhaust the shared provider quota however many
 * customers it has.  They live here so the gateway and the billing server
 * read the same numbers.
 */
export const ORG_RATE_LIMITS = { rpm: 600, tpm: 4_000_000 };

/**
 * The identity a virtual key carries: `<org>:<customer>`.
 *
 * The gateway resolves the tenant from this and nothing else.  A merchant's
 * app cannot name another tenant, because the key is minted here and only
 * the master key can create one.
 */
export const litellmIdentity = (orgId: string, customerId: string): string =>
  `${orgId}:${customerId}`;

/**
 * The models this org may call, by the name the gateway knows them by.
 *
 * An empty list means every model the gateway offers -- that is an org that
 * never listed a price sheet, and it keeps the pre-P2 behaviour.  Once the
 * org has a price sheet, the enabled models are the allow-list.
 */
const getOrgAllowedModels = async ({
  db,
  orgId,
  env,
}: {
  db: DrizzleCli;
  orgId: string;
  env: AppEnv;
}): Promise<string[]> => {
  const rows = await db.query.servedModels.findMany({
    where: and(eq(servedModels.org_id, orgId), eq(servedModels.env, env)),
  });
  if (rows.length === 0) return [];
  return rows
    .filter((row) => row.enabled)
    .map((row) => row.upstream_model ?? row.model_id);
};

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

/**
 * The plan a customer is on, which decides their budget and rate limits.
 */
export const resolveCustomerPlanKey = async ({
  ctx,
  customer,
}: {
  ctx: AutumnContext;
  customer: { internal_id: string };
}): Promise<string> => {
  const rows = await ctx.db
    .select({ productId: customerProducts.product_id })
    .from(customerProducts)
    .where(
      and(
        eq(customerProducts.internal_customer_id, customer.internal_id),
        eq(customerProducts.status, "active"),
      ),
    )
    .limit(1);

  return rows[0]?.productId ?? "free";
};

/**
 * Bring every virtual key of an org back in line with its price sheet.
 *
 * The gateway enforces the model allow-list on the key, so a merchant who
 * enables a model (or switches one off) has to reach the gateway, not just
 * the billing server.  Keys that cannot be synced are logged and left
 * alone: a stale allow-list must not stop the merchant serving.
 */
export async function syncOrgLitellmKeys(
  ctx: AutumnContext,
  orgId: string,
): Promise<{ synced: number; failed: number }> {
  const rows = await ctx.db
    .select({
      id: customers.id,
      internalId: customers.internal_id,
    })
    .from(customers)
    .where(
      and(
        eq(customers.org_id, orgId),
        isNotNull(customers.litellm_virtual_key),
      ),
    );

  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const planKey = await resolveCustomerPlanKey({
        ctx,
        customer: { internal_id: row.internalId },
      });
      await provisionLitellmKey(ctx, {
        customerId: row.id as string,
        planKey,
      });
      synced++;
    } catch (error) {
      failed++;
      logger.error({
        msg: "litellm: could not sync a customer's key to the org's price sheet",
        orgId,
        customerId: row.id,
        err: String(error),
      });
    }
  }

  return { synced, failed };
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
  const orgId = ctx.org.id;
  const maxBudget =
    args.planMaxBudgetUsd ?? LITELLM_BUDGET_PER_PLAN[planKey] ?? 5;
  const limits =
    LITELLM_RATE_LIMITS_PER_PLAN[planKey] ??
    LITELLM_RATE_LIMITS_PER_PLAN.free;
  const allowedModels = await getOrgAllowedModels({
    db: ctx.db,
    orgId,
    env: ctx.env,
  });

  // The key's identity: the tenant, and the customer inside it.  The
  // gateway resolves both from this and bills that tenant.
  const identity = litellmIdentity(orgId, customerId);
  const keyAlias = `meterpal:${identity}`;

  const [existing] = await ctx.db
    .select({ litellmVirtualKey: customers.litellm_virtual_key })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  // Idempotent: if we already have a key, just update its limits and
  // identity.
  if (existing?.litellmVirtualKey) {
    const upd = await litellmFetch("/key/update", {
      key: existing.litellmVirtualKey,
      key_alias: keyAlias,
      user_id: identity,
      max_budget: maxBudget,
      budget_duration: LITELLM_BUDGET_DURATION,
      models: allowedModels,
      rpm_limit: limits.rpm,
      tpm_limit: limits.tpm,
      metadata: {
        autumn_org_id: orgId,
        autumn_customer_id: customerId,
        plan: planKey,
      },
    });
    if (upd.status >= 400) {
      await audit(ctx, customerId, "update", "system", existing.litellmVirtualKey, null, JSON.stringify(upd.body));
      throw new Error(`litellm /key/update ${upd.status}: ${JSON.stringify(upd.body)}`);
    }
    await audit(ctx, customerId, "update", "system", existing.litellmVirtualKey, { planKey, maxBudget, identity, allowedModels, limits }, null);
    return { key: existing.litellmVirtualKey, created: false };
  }

  const generateBody = {
    user_id: identity,
    max_budget: maxBudget,
    budget_duration: LITELLM_BUDGET_DURATION,
    key_alias: keyAlias,
    models: allowedModels,
    rpm_limit: limits.rpm,
    tpm_limit: limits.tpm,
    metadata: {
      autumn_org_id: orgId,
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