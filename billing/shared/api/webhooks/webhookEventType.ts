export enum WebhookEventType {
	CustomerProductsUpdated = "customer.products.updated",
	CustomerThresholdReached = "customer.threshold_reached",

	BalancesUsageAlertTriggered = "balances.usage_alert_triggered",
	BalancesLimitReached = "balances.limit_reached",

	BillingAutoTopupFailed = "billing.auto_topup_failed",
	BillingAutoTopupSucceeded = "billing.auto_topup_succeeded",
	BillingDisputeCreated = "billing.dispute_created",
	BillingDisputeUpdated = "billing.dispute_updated",
	BillingUpdated = "billing.updated",

	InvoiceFinalized = "invoice.finalized",

	VercelResourcesDeleted = "vercel.resources.deleted",
	VercelResourcesProvisioned = "vercel.resources.provisioned",
	VercelResourcesRotateSecrets = "vercel.resources.rotate_secrets",
	VercelWebhooksEvent = "vercel.webhooks.event",
}
