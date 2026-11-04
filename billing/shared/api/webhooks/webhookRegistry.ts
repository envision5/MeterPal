import type { z } from "zod/v4";
import { BalancesLimitReachedSchema } from "./balances/balancesLimitReached.js";
import { BalancesUsageAlertTriggeredSchema } from "./balances/balancesUsageAlertTriggered.js";
import { BillingAutoTopupFailedSchema } from "./billing/billingAutoTopupFailed.js";
import { BillingAutoTopupSucceededSchema } from "./billing/billingAutoTopupSucceeded.js";
import { BillingUpdatedSchema } from "./billing/billingUpdated.js";
import { InvoiceFinalizedSchema } from "./invoice/invoiceFinalized.js";
import { WebhookEventType } from "./webhookEventType.js";

export interface WebhookDefinition {
	eventType: string;
	operationId: string;
	title: string;
	schema?: z.ZodType;
	description: string;
	group: string;
	deprecated?: boolean;
	archived?: boolean;
	featureFlags?: string[];
}

export const webhookRegistry: WebhookDefinition[] = [
	// ── Customer ──────────────────────────────────────────────────────────
	{
		eventType: WebhookEventType.CustomerProductsUpdated,
		operationId: "customerProductsUpdated",
		title: "Products Updated",
		group: "Customer",
		description: "",
	},
	{
		eventType: WebhookEventType.CustomerThresholdReached,
		operationId: "customerThresholdReached",
		title: "Threshold Reached",
		group: "Customer",
		description: "",
	},

	// ── Balances ──────────────────────────────────────────────────────────
	{
		eventType: WebhookEventType.BalancesUsageAlertTriggered,
		operationId: "balancesUsageAlertTriggered",
		title: "Usage Alert Triggered",
		schema: BalancesUsageAlertTriggeredSchema,
		group: "Balances",
		description:
			"Fired when a customer crosses a configured usage alert threshold.",
	},
	{
		eventType: WebhookEventType.BalancesLimitReached,
		operationId: "balancesLimitReached",
		title: "Limit Reached",
		schema: BalancesLimitReachedSchema,
		group: "Balances",
		description:
			"Fired when a customer reaches the limit for a feature (included allowance, max purchase, spend limit, or a usage-limit billing control).",
	},

	// ── Billing ───────────────────────────────────────────────────────────
	{
		eventType: WebhookEventType.BillingAutoTopupFailed,
		operationId: "billingAutoTopupFailed",
		title: "Auto Top-Up Failed",
		schema: BillingAutoTopupFailedSchema,
		group: "Billing",
		description:
			"Fired when an automatic top-up is blocked, declined, or fails before granting additional prepaid balance.",
	},
	{
		eventType: WebhookEventType.BillingAutoTopupSucceeded,
		operationId: "billingAutoTopupSucceeded",
		title: "Auto Top-Up Succeeded",
		schema: BillingAutoTopupSucceededSchema,
		group: "Billing",
		description:
			"Fired when an automatic top-up grants additional prepaid balance.",
	},
	{
		eventType: WebhookEventType.BillingUpdated,
		operationId: "billingUpdated",
		title: "Plans Updated",
		schema: BillingUpdatedSchema,
		group: "Billing",
		description:
			"Fired when a customer's plans change — activated, scheduled, updated, or expired. Each event carries a `plan_changes` array describing what happened and a `tags` array (e.g. `trial_ended`, `phase_changed`) describing why.",
	},

	// ── Invoice ───────────────────────────────────────────────────────────
	{
		eventType: WebhookEventType.InvoiceFinalized,
		operationId: "invoiceFinalized",
		title: "Invoice Finalized",
		schema: InvoiceFinalizedSchema,
		group: "Invoice",
		description:
			"Fired when a PayPal invoice is finalized and its line items have been reconciled. The body is the invoice as returned by `invoices.list`, with `items` populated and each item carrying a per-entity `entities` breakdown.",
	},
];
