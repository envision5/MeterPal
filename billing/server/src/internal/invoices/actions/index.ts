import { insertInvoices } from "./insertInvoices";
import { upsertInvoiceToDbAndCache } from "./upsertDbAndCache";

export const invoiceActions = {
	insert: insertInvoices,
	upsertToDbAndCache: upsertInvoiceToDbAndCache,
} as const;
