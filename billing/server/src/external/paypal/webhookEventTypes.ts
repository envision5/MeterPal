// billing/server/src/external/paypal/webhookEventTypes.ts
//
// The PayPal event types MeterPal understands, in one place: the webhook
// registration (what we subscribe to) and the dispatch filter (what we
// handle) must never drift apart — a subscribed-but-unhandled event wastes
// PayPal deliveries, and a handled-but-unsubscribed one is silently lost.

export const PAYPAL_WEBHOOK_EVENT_TYPES = [
	// Subscription lifecycle
	"BILLING.SUBSCRIPTION.CREATED",
	"BILLING.SUBSCRIPTION.ACTIVATED",
	"BILLING.SUBSCRIPTION.RE-ACTIVATED",
	"BILLING.SUBSCRIPTION.UPDATED",
	"BILLING.SUBSCRIPTION.SUSPENDED",
	"BILLING.SUBSCRIPTION.CANCELLED",
	"BILLING.SUBSCRIPTION.EXPIRED",
	"BILLING.SUBSCRIPTION.PAYMENT.FAILED",

	// Money in / money out
	"PAYMENT.SALE.COMPLETED",
	"PAYMENT.SALE.REFUNDED",
	"PAYMENT.SALE.REVERSED",
	"PAYMENT.CAPTURE.COMPLETED",
	"PAYMENT.CAPTURE.REFUNDED",
	"PAYMENT.CAPTURE.REVERSED",

	// Disputes (chargebacks, item-not-received claims)
	"CUSTOMER.DISPUTE.CREATED",
	"CUSTOMER.DISPUTE.UPDATED",
	"CUSTOMER.DISPUTE.RESOLVED",

	// Overage invoices
	"INVOICING.INVOICE.PAID",
	"INVOICING.INVOICE.REFUNDED",
	"INVOICING.INVOICE.CANCELLED",

	// Early order signal (money event is PAYMENT.CAPTURE.COMPLETED)
	"CHECKOUT.ORDER.APPROVED",
] as const;

export type PayPalWebhookEventType =
	(typeof PAYPAL_WEBHOOK_EVENT_TYPES)[number];
