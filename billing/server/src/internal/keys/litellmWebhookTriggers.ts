// billing/server/src/internal/keys/litellmWebhookTriggers.ts
//
// Wires customer lifecycle events to the LiteLLM provisioning handler.
// Place this file under server/src/internal/keys/ and import from the
// existing trigger/ dispatcher in server/src/trigger/.
//
// Idempotency: every handler tolerates re-entry (same webhook event may
// be replayed by the SQS queue). provisionLitellmKey is itself idempotent.

import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { provisionLitellmKey, blockLitellmKey } from "@/internal/keys/litellmKeys.js";
import { logger } from "@/external/logtail/logtailUtils.js";

export async function onSubscriptionActive(
  ctx: AutumnContext,
  evt: { customer_id: string; plan_key: string; plan_max_budget_usd?: number },
): Promise<void> {
  try {
    const out = await provisionLitellmKey(ctx, {
      customerId: evt.customer_id,
      planKey: evt.plan_key,
      planMaxBudgetUsd: evt.plan_max_budget_usd,
    });
    logger.info({
      msg: "litellm key provisioned",
      customerId: evt.customer_id,
      planKey: evt.plan_key,
      created: out?.created,
    });
  } catch (e) {
    logger.error({
      msg: "litellm provisioning failed",
      customerId: evt.customer_id,
      planKey: evt.plan_key,
      err: String(e),
    });
    // Surface to Sentry via the trigger framework; do not throw — webhook
    // event handlers must not fail the whole flow on bridge errors.
  }
}

export async function onSubscriptionCancelled(
  ctx: AutumnContext,
  evt: { customer_id: string; reason?: string },
): Promise<void> {
  try {
    await blockLitellmKey(ctx, evt.customer_id);
    logger.info({
      msg: "litellm key blocked",
      customerId: evt.customer_id,
      reason: evt.reason,
    });
  } catch (e) {
    logger.error({
      msg: "litellm block failed",
      customerId: evt.customer_id,
      err: String(e),
    });
  }
}

export async function onSubscriptionPlanChanged(
  ctx: AutumnContext,
  evt: { customer_id: string; plan_key: string; plan_max_budget_usd?: number },
): Promise<void> {
  // Treat a plan change like a fresh provisioning — provisionLitellmKey
  // detects the existing key and just updates its budget.
  await onSubscriptionActive(ctx, evt);
}