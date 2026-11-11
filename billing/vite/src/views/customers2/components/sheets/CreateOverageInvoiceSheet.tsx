import type { FullCustomer } from "@autumn/shared";
import {
	Button,
	FormLabel,
	Input,
	ShortcutButton,
	Textarea,
} from "@autumn/ui";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import {
	LayoutGroup,
	SheetFooter,
	SheetHeader,
	SheetSection,
} from "@/components/v2/sheets/SharedSheetComponents";
import { useSheetStore } from "@/hooks/stores/useSheetStore";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { getBackendErr } from "@/utils/genUtils";
import { useCusQuery } from "@/views/customers/customer/hooks/useCusQuery";

/**
 * Create a PayPal overage invoice for a customer.
 *
 * This is the only invoice a merchant can issue by hand today: the amount is
 * post-paid usage that already happened, so the merchant (or an agent) names
 * the number rather than the platform deriving it from a plan.
 *
 * Posts to /v1/overage_invoices, which drafts + sends the invoice in PayPal and
 * records the row immediately — so the invoice shows in the table below before
 * the buyer has paid it.
 */
export function CreateOverageInvoiceSheet() {
	const closeSheet = useSheetStore((s) => s.closeSheet);
	const { customer, refetch } = useCusQuery();
	const axiosInstance = useAxiosInstance();

	const cus = customer as FullCustomer | null;
	const customerId = cus?.id || cus?.internal_id;
	const email = cus?.email ?? null;

	const [amount, setAmount] = useState("");
	const [itemName, setItemName] = useState("AI usage overage");
	const [memo, setMemo] = useState("");
	const [dueDate, setDueDate] = useState("");
	const [isCreating, setIsCreating] = useState(false);

	const parsedAmount = Number.parseFloat(amount);
	const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
	const canSubmit = Boolean(customerId) && Boolean(email) && amountValid;

	const handleCreate = async () => {
		if (!customerId || !canSubmit) return;

		setIsCreating(true);
		try {
			const body: Record<string, unknown> = {
				customer_id: customerId,
				amount_usd: parsedAmount,
				item_name: itemName.trim() || "AI usage overage",
			};
			if (memo.trim()) body.memo = memo.trim();
			if (dueDate) body.due_date = dueDate;

			const { data } = await axiosInstance.post("/v1/overage_invoices", body);

			await refetch();
			closeSheet();
			toast.success(
				data?.invoice_number
					? `Invoice ${data.invoice_number} sent to ${email}`
					: `Invoice sent to ${email}`,
			);
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to create invoice"));
		} finally {
			setIsCreating(false);
		}
	};

	return (
		<LayoutGroup>
			<div className="flex h-full flex-col overflow-y-auto">
				<SheetHeader
					title="Create Invoice"
					description="Send a PayPal invoice for AI usage this customer has already consumed. Paying it credits their wallet automatically."
				/>

				{!email && (
					<div className="mx-6 mb-2 flex items-start gap-2 rounded-md border border-border p-3 text-sm text-tertiary-foreground">
						<WarningCircleIcon className="mt-0.5 size-4 shrink-0" />
						<span>
							This customer has no email address. PayPal invoicing needs one —
							add an email to the customer first.
						</span>
					</div>
				)}

				<SheetSection withSeparator>
					<div className="flex flex-col gap-3">
						<div>
							<FormLabel>Amount (USD)</FormLabel>
							<Input
								placeholder="eg, 12.34"
								type="number"
								min="0"
								step="0.01"
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
							/>
						</div>

						<div>
							<FormLabel>Line item</FormLabel>
							<Input
								placeholder="AI usage overage"
								value={itemName}
								onChange={(e) => setItemName(e.target.value)}
							/>
						</div>

						<div>
							<FormLabel>Due date</FormLabel>
							<Input
								type="date"
								value={dueDate}
								onChange={(e) => setDueDate(e.target.value)}
							/>
							<p className="mt-1 text-xs text-tertiary-foreground">
								Leave blank for net 30.
							</p>
						</div>

						<div>
							<FormLabel>Memo</FormLabel>
							<Textarea
								placeholder="Shown to the payer on the invoice"
								value={memo}
								onChange={(e) => setMemo(e.target.value)}
							/>
						</div>
					</div>
				</SheetSection>

				<div className="flex-1" />

				<SheetFooter>
					<Button
						variant="secondary"
						className="w-full"
						onClick={closeSheet}
						disabled={isCreating}
					>
						Cancel
					</Button>
					<ShortcutButton
						variant="primary"
						className="w-full"
						onClick={() => handleCreate()}
						isLoading={isCreating}
						disabled={!canSubmit}
						metaShortcut="enter"
					>
						Create &amp; send
					</ShortcutButton>
				</SheetFooter>
			</div>
		</LayoutGroup>
	);
}
