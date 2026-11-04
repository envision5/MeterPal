import type { Invoice } from "@autumn/shared";
import { processInvoice } from "./InvoiceService.js";

export const invoicesToResponse = ({ invoices }: { invoices: Invoice[] }) =>
	invoices.map((i) =>
		processInvoice({
			invoice: i,
			withItems: false,
			features: [],
		}),
	);
