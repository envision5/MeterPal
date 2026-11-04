import { expect } from "bun:test";

export const expectInvoicePlanIdsCorrect = ({
	invoices,
	processorInvoiceId,
	planIds,
}: {
	invoices: Array<{ processor_invoice_id: string; plan_ids: string[] }>;
	processorInvoiceId: string;
	planIds: string[];
}) => {
	const invoice = invoices.find((row) => row.processor_invoice_id === processorInvoiceId);
	expect(invoice, `missing invoice ${processorInvoiceId}`).toBeDefined();
	expect(
		[...(invoice?.plan_ids ?? [])].sort(),
		`plan_ids=${JSON.stringify(invoice?.plan_ids)}`,
	).toEqual([...planIds].sort());
};
