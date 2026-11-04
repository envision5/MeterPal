import { attach } from "@/internal/billing/v2/actions/attach/attach";
import { attachLicense } from "@/internal/billing/v2/actions/attachLicense/attachLicense";
import { multiAttach } from "@/internal/billing/v2/actions/multiAttach/multiAttach";
import { multiUpdate } from "@/internal/billing/v2/actions/multiUpdate/multiUpdate";
import { releaseLicense } from "@/internal/billing/v2/actions/releaseLicense/releaseLicense";
import { rollback } from "@/internal/billing/v2/actions/rollback/rollback";
import { updateSubscription } from "@/internal/billing/v2/actions/updateSubscription/updateSubscription";

export const billingActions = {
	attach: attach,
	attachLicense: attachLicense,
	multiAttach: multiAttach,
	multiUpdate: multiUpdate,
	updateSubscription: updateSubscription,
	releaseLicense: releaseLicense,
	rollback: rollback,
} as const;
