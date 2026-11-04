import { expect } from "bun:test";
import type {
	ApiListInvoiceV1,
	CreateInvoiceParamsInput,
	CreateInvoiceResponse,
	InvoiceDiscount,
} from "@autumn/shared";
import { invoices } from "@autumn/shared";
import { eq } from "drizzle-orm";
import type { initScenario } from "@tests/utils/testInitUtils/initScenario";

type Client = Awaited<ReturnType<typeof initScenario>>["autumnV2_3"];
type Ctx = Awaited<ReturnType<typeof initScenario>>["ctx"];

export const createInvoice = ({
	autumnV2_3,
	params,
}: {
	autumnV2_3: Client;
	params: CreateInvoiceParamsInput;
}) =>
	autumnV2_3.post("/invoices.create", params) as Promise<CreateInvoiceResponse>;

type ExpectedLine = {
	description?: string | RegExp;
	amount: number;
	quantity?: number | null;
	prorated?: boolean;
};

/**
 * Asserts a created invoice against the invoice row it produced and the
 * Autumn row. `lines` are matched in order of the preview.
 */
export const expectCreatedInvoiceCorrect = async ({
	ctx,
	response,
	lines,
	total,
	status = "open",
	dueInDays,
	discountTotal,
}: {
	ctx: Ctx;
	response: CreateInvoiceResponse;
	lines: ExpectedLine[];
	total: number;
	status?: "open" | "paid";
	dueInDays?: number;
	discountTotal?: number;
}): Promise<{ invoice: ApiListInvoiceV1 }> => {
	const { invoice, preview } = response;
	expect(invoice).not.toBeNull();
	if (!invoice) throw new Error("no invoice");

	expect(preview.lines.length).toBe(lines.length);
	lines.forEach((expected, index) => {
		const line = preview.lines[index];
		expect(line.amount).toBeCloseTo(expected.amount, 2);
		if (expected.description instanceof RegExp) {
			expect(line.description).toMatch(expected.description);
		} else if (expected.description) {
			expect(line.description).toBe(expected.description);
		}
		if (expected.quantity !== undefined)
			expect(line.quantity).toBe(expected.quantity);
		if (expected.prorated !== undefined)
			expect(line.prorated).toBe(expected.prorated);
	});
	expect(preview.total).toBeCloseTo(total, 2);

	expect(invoice.status).toBe(status);
	expect(invoice.total).toBeCloseTo(total, 2);

	if (dueInDays !== undefined) {
		expect(preview.due_date).not.toBeNull();
		const days = ((preview.due_date ?? 0) - Date.now()) / 86_400_000;
		expect(Math.round(days)).toBe(dueInDays);
	}

	// The invoice row is the source of truth for what was billed.
	const rows = await ctx.db
		.select()
		.from(invoices)
		.where(eq(invoices.processor_invoice_id, invoice.processor_invoice_id));

	expect(rows.length, `no invoice row for ${invoice.processor_invoice_id}`).toBe(
		1,
	);
	const row = rows[0];
	expect(row.status).toBe(status);
	expect(row.total).toBeCloseTo(total, 2);

	if (discountTotal !== undefined) {
		const discounts = (row.discounts ?? []) as InvoiceDiscount[];
		const discounted = discounts.reduce(
			(sum, discount) => sum + discount.amount_off,
			0,
		);
		expect(discounted).toBeCloseTo(discountTotal, 2);
	}

	return { invoice };
};
