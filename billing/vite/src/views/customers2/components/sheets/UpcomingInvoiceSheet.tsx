import type { ApiInvoicePreviewV0 } from "@autumn/shared";
import { InfoRow, MiniCopyButton } from "@autumn/ui";
import { CalendarBlankIcon, CreditCardIcon } from "@phosphor-icons/react";
import { format } from "date-fns";
import { SheetHeader, SheetSection } from "@/components/v2/sheets/InlineSheet";
import { useProductsQuery } from "@/hooks/queries/useProductsQuery";
import {
	CustomerInvoiceStatus,
	UPCOMING_INVOICE_STATUS,
} from "../table/customer-invoices/CustomerInvoiceStatus";
import { productIdsToNames } from "../table/customer-invoices/getInvoiceProductNames";
import { formatInvoiceCurrency } from "../table/customer-invoices/invoiceAmountUtils";

const formatDate = (timestamp: number) =>
	format(new Date(timestamp), "MMM d, yyyy");

export function UpcomingInvoiceSheet({
	preview,
}: {
	preview: ApiInvoicePreviewV0;
}) {
	const { products } = useProductsQuery();

	const productLabel =
		productIdsToNames({
			productIds: preview.plan_ids,
			products: products ?? [],
		}) || "Upcoming charges";

	const discountAmount = preview.subtotal - preview.total;

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<SheetHeader
				title={
					<div className="flex items-center gap-2">
						<span>Invoice</span>
						<CustomerInvoiceStatus override={UPCOMING_INVOICE_STATUS} />
					</div>
				}
				description={`${formatDate(preview.invoice_at)} • ${formatInvoiceCurrency(
					preview.total,
					preview.currency,
				)}`}
			/>

			<SheetSection withSeparator={true}>
				<div className="mb-2">
					<span className="truncate text-tertiary-foreground text-xs">
						{productLabel}
					</span>
				</div>

				<div className="flex flex-col gap-3">
					{preview.line_items.map((lineItem, index) => (
						<div
							key={`${lineItem.plan_id}-${lineItem.feature_id ?? "base"}-${index}`}
							className="flex items-start justify-between gap-3"
						>
							<div className="flex min-w-0 flex-col">
								<span className="text-foreground text-sm">
									{lineItem.display_name}
								</span>
								{lineItem.description ? (
									<span className="text-tertiary-foreground text-xs">
										{lineItem.description}
									</span>
								) : null}
							</div>
							<span className="shrink-0 text-foreground text-sm tabular-nums">
								{formatInvoiceCurrency(lineItem.total, preview.currency)}
							</span>
						</div>
					))}
				</div>
			</SheetSection>

			<SheetSection withSeparator={true}>
				<div className="space-y-2">
					{discountAmount > 0 && (
						<>
							<div className="flex items-center justify-between">
								<span className="text-muted-foreground text-sm">Subtotal</span>
								<span className="text-muted-foreground text-sm tabular-nums">
									{formatInvoiceCurrency(preview.subtotal, preview.currency)}
								</span>
							</div>
							<div className="flex items-center justify-between">
								<span className="text-muted-foreground text-sm">Discounts</span>
								<span className="text-muted-foreground text-sm tabular-nums">
									-{formatInvoiceCurrency(discountAmount, preview.currency)}
								</span>
							</div>
						</>
					)}
					<div className="flex items-center justify-between">
						<span className="text-foreground text-sm">Total</span>
						<span className="text-foreground text-sm tabular-nums">
							{formatInvoiceCurrency(preview.total, preview.currency)}
						</span>
					</div>
				</div>
			</SheetSection>

			<SheetSection withSeparator={false}>
				<div className="space-y-3">
					<InfoRow
						icon={<CreditCardIcon size={16} weight="duotone" />}
						label="Subscription"
						value={
							<MiniCopyButton
								text={preview.subscription_id}
								innerClassName="text-sm text-foreground font-mono"
							/>
						}
					/>
					<InfoRow
						icon={<CalendarBlankIcon size={16} weight="duotone" />}
						label="Bills at"
						value={
							<MiniCopyButton
								text={format(new Date(preview.invoice_at), "MMM d, yyyy HH:mm")}
								innerClassName="text-sm text-foreground"
							/>
						}
					/>
				</div>
			</SheetSection>
		</div>
	);
}
