import { type Invoice, type InvoiceDiscount } from "@autumn/shared";
import type { Row } from "@tanstack/react-table";
import { AdminHover } from "@/components/general/AdminHover";
import { getInvoiceHoverTexts } from "@/views/admin/adminUtils";
import { createDateTimeColumn } from "@/views/customers2/utils/ColumnHelpers";
import { CustomerInvoiceStatus } from "./CustomerInvoiceStatus";
import { InvoiceTotalCell } from "./invoiceAmountUtils";

type CustomerInvoice = Invoice & {
	productNames: string;
};

const getTotalDiscountAmount = (invoice: Invoice) => {
	return invoice.discounts.reduce((acc: number, discount: InvoiceDiscount) => {
		return acc + discount.amount_used;
	}, 0);
};

export const getCustomerInvoicesColumns = () => [
	{
		header: "Products",
		accessorKey: "productNames",
		size: 360,
		cell: ({ row }: { row: Row<CustomerInvoice> }) => {
			return (
				<div className="min-w-0 max-w-full" title={row.original.productNames}>
					<AdminHover texts={getInvoiceHoverTexts({ invoice: row.original })}>
						<span className="block max-w-full truncate">
							{row.original.productNames}
						</span>
					</AdminHover>
				</div>
			);
		},
	},
	{
		header: "Total",
		accessorKey: "total",
		size: 120,
		cell: ({ row }: { row: Row<CustomerInvoice> }) => {
			const invoice = row.original;
			return (
				<InvoiceTotalCell
					total={invoice.total}
					currency={invoice.currency}
					discountAmount={getTotalDiscountAmount(invoice)}
				/>
			);
		},
	},
	{
		header: "Status",
		accessorKey: "status",
		cell: ({ row }: { row: Row<CustomerInvoice> }) => {
			const invoice = row.original;
			return (
				<CustomerInvoiceStatus
					status={invoice.status}
					total={invoice.total}
					amountPaid={invoice.amount_paid}
					refundedAmount={invoice.refunded_amount}
				/>
			);
		},
	},
	createDateTimeColumn<CustomerInvoice>({
		header: "Created At",
		accessorKey: "created_at",
		withYear: true,
	}),
];
