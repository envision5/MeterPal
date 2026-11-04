import type { TestGroup } from "../types";
import { coreBatchReset } from "./coreBatchReset";
import { coreBillingOthers } from "./coreBillingOthers";
import { coreLegacy } from "./coreLegacy";
import { coreLicensesBilling } from "./coreLicensesBilling";
import { coreMultiUpdate } from "./coreMultiUpdate";
import { corePlansCrud } from "./corePlansCrud";
import { coreUpdateSubscription } from "./coreUpdateSubscription";

export const coreBilling: TestGroup = {
	name: "core-billing",
	description:
		"Core billing and catalog tests: billing lifecycles, licenses, and plans CRUD",
	tier: "core",
	paths: [
		...coreUpdateSubscription.paths,
		...coreMultiUpdate.paths,
		...coreBillingOthers.paths,
		...coreLegacy.paths,
		...coreLicensesBilling.paths,
		...corePlansCrud.paths,

		// ── Pooled balances ──
		"integration/billing/pooled-balances",
		...coreBatchReset.paths,
	],
};
