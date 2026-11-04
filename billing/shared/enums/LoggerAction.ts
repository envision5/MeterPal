export enum LoggerAction {
	AdjustAllowance = "adjust_allowance",

	// Processor Webhook
	ProcessorWebhook = "processor_webhook",
	ProcessorWebhookInvoiceCreated = "processor_webhook_invoice_created",

	// Invoice
	InsertProcessorInvoice = "insert_processor_invoice",
	CreateFullCusProduct = "create_full_cus_product",
}
