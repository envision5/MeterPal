/**
 * Seeds plans, customers and invoice templates for the Create Invoice sheet.
 *
 *   bun scenario invoice [--skip-clear]
 */
import { ApiVersion } from "@autumn/shared";

import { items } from "@tests/utils/fixtures/items";
import { products } from "@tests/utils/fixtures/products";
import { clearOrg } from "@tests/utils/setup/clearOrg.js";
import { ensureV2Features } from "@tests/utils/setup/setupOrg.js";
import { createTestContext } from "@tests/utils/testInitUtils/createTestContext.js";
import { initScenario, s } from "@tests/utils/testInitUtils/initScenario";
import { AutumnInt } from "@/external/autumn/autumnCli.js";
import { InvoiceTemplateService } from "@/internal/orgs/invoiceTemplates/InvoiceTemplateService";
import { generateId } from "@/utils/genUtils";

const GROUP = "invoice-create";
const PRIMARY_CUSTOMER = "inv_cus_1";
const SECOND_CUSTOMER = "inv_cus_2";

export const runInvoiceCreateSeed = async () => {
	const skipClear = process.argv.includes("--skip-clear");

	if (!skipClear) {
		const stale = await createTestContext();
		await clearOrg({ orgSlug: stale.org.slug, env: stale.env });
	}

	const ctx = await createTestContext();

	await ensureV2Features({ db: ctx.db, orgId: ctx.org.id, env: ctx.env });

	// products.pro already carries a monthly base price; a second one is rejected.
	const basic = products.pro({ id: "inv_basic", items: [] });
	const seats = products.pro({
		id: "inv_seats",
		items: [items.prepaidUsers({ includedUsage: 1 })],
	});
	const tiered = products.pro({
		id: "inv_tiered",
		items: [items.tieredPrepaidMessages({ includedUsage: 0 })],
	});
	const usage = products.pro({
		id: "inv_usage",
		items: [items.consumableMessages({ includedUsage: 0, price: 0.1 })],
	});
	// A license plan is a separate product linked to a parent, so seat charges
	// come through license_quantities rather than feature_quantities.
	const licensed = products.pro({ id: "inv_licensed", items: [] });
	const editor = products.base({
		id: "inv_editor",
		items: [items.monthlyPrice({ price: 25 })],
	});

	const list = [basic, seats, tiered, usage, licensed, editor].map((plan) => ({
		...plan,
		group: GROUP,
	}));

	const { autumnV2_3 } = await initScenario({
		customerId: PRIMARY_CUSTOMER,
		setup: [
			s.products({ list, prefix: "" }),
			s.customer({ paymentMethod: "success" }),
			s.otherCustomers([{ id: SECOND_CUSTOMER, paymentMethod: "success" }]),
		],
		actions: [],
		ctx,
	});

	// s.licenses.link() suffixes plan ids with the product prefix, which this
	// seed does not use, so the catalog link is written directly.
	await autumnV2_3.post("/plans.update", {
		plan_id: licensed.id,
		licenses: [{ license_plan_id: editor.id, included: 0 }],
	});

	const templates = [
		{
			id: "inv_tmpl_bank_transfer",
			values: {
				name: "Bank transfer",
				footer: "Pay by wire to IBAN GB00 EXAM 0000 0000 0000 00",
				memo: "Questions? billing@example.com",
				net_terms_days: 30,
			},
		},
		{
			id: "inv_tmpl_net_14",
			values: {
				name: "Net 14",
				footer: "Payment due within 14 days.",
				memo: "Thanks for your business.",
				net_terms_days: 14,
			},
		},
	];
	for (const { id, values } of templates) {
		const updated = await InvoiceTemplateService.update({
			db: ctx.db,
			orgId: ctx.org.id,
			id,
			update: values,
		});
		if (updated) continue;

		await InvoiceTemplateService.create({
			db: ctx.db,
			orgId: ctx.org.id,
			internalId: generateId("inv_tmpl_int"),
			id,
			values,
		});
	}

	console.log("\n✅ Seeded invoices.create test data");
	console.log(`   plans:     ${list.map((plan) => plan.id).join(", ")}`);
	console.log(`   customers: ${PRIMARY_CUSTOMER}, ${SECOND_CUSTOMER}`);
	console.log(
	);
	console.log(`   templates: ${templates.map((t) => t.values.name).join(", ")}\n`);
};
