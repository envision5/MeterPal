import type {
	Entity,
	EntityRolloverBalance,
	Feature,
	FullCusProduct,
	FullCustomerEntitlement,
	Invoice,
	Product,
	ProductItem,
	ProductV2,
	Rollover,
} from "@autumn/shared";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { setActiveOrg } from "@/lib/orgSync";
import type { useAxiosInstance } from "@/services/useAxiosInstance";
import { formatUnixToDate } from "../../utils/formatUtils/formatDateUtils";

export const getCusProductHoverTexts = (cusProduct: FullCusProduct) => {
	return [
		{
			key: "Cus Product ID",
			value: cusProduct.id,
		},
		...(cusProduct.subscription_ids
			? cusProduct.subscription_ids.map((id: string) => ({
					key: "Stripe Subscription ID",
					value: id,
				}))
			: []),
		...(cusProduct.scheduled_ids
			? [
					{
						key: "Stripe Scheduled IDs",
						value: cusProduct.scheduled_ids.join(", "),
					},
				]
			: []),
		{
			key: "Entity ID",
			value: cusProduct.entity_id || "N/A",
		},
	];
};

// Landing path after an admin impersonates into an org (the admin-table
// "Impersonate" action). Unlike ImpersonateRedirect — which serves the org
// owner's own entry and honors the onboarding flow — an impersonating admin
// is inspecting the org, so the default target is the org's dashboard.
// Onboarding only for orgs that haven't finished it, per the org record
// (not the admin's browser-local onboarding-dismissed flag).
export const resolveImpersonationLanding = async (
	axiosInstance: ReturnType<typeof useAxiosInstance>,
): Promise<string> => {
	try {
		const { data } = await axiosInstance.get("/organization");
		if (data?.deployed) return "/products?tab=products";
		if (data?.onboarded === false) return "/sandbox/onboarding";
		return "/sandbox/products?tab=products";
	} catch {
		// Couldn't resolve the org record; the sandbox dashboard is the safe
		// default (a live route may not exist for an undeployed org).
		return "/sandbox/products?tab=products";
	}
};

export const impersonateUser = async ({
	userId,
	organizationId,
	isCurrentlyImpersonating = false,
	axiosInstance,
}: {
	userId: string;
	organizationId?: string;
	isCurrentlyImpersonating?: boolean;
	axiosInstance?: ReturnType<typeof useAxiosInstance>;
}) => {
	if (isCurrentlyImpersonating) {
		const { error } = await authClient.admin.stopImpersonating();
		if (error) {
			toast.error(error.message || "Failed to restore admin session");
			return;
		}
	}
	const res = await authClient.admin.impersonateUser({ userId });
	if (res.error) {
		toast.error(res.error.message || "Failed to impersonate user");
		return;
	}

	if (organizationId) {
		await setActiveOrg(organizationId);

		// Confirm the session reflects the target before reloading. The
		// impersonation session is born with no active org, so a premature reload
		// lets handleNoActiveOrg pick the wrong org.
		const { data } = await authClient.getSession({
			query: { disableCookieCache: true },
		});
		if (data?.session.activeOrganizationId !== organizationId) {
			toast.error("Failed to switch to the target organization");
			return;
		}

		// Land in the target org's dashboard instead of reloading the admin
		// page in place. Without an axios instance there's no org record to
		// resolve a landing from, so fall back to the in-place reload and let
		// handleNoActiveOrg sort the session out (Users-tab flow passes no org).
		if (axiosInstance) {
			window.location.href =
				await resolveImpersonationLanding(axiosInstance);
			return;
		}
	}

	window.location.reload();
};

export const getCusEntHoverTexts = ({
	cusEnt,
	entities,
}: {
	cusEnt?: FullCustomerEntitlement;
	entities: Entity[];
}) => {
	if (!cusEnt) return [];
	const entitlement = cusEnt.entitlement;
	const featureEntities = entities.filter(
		(e: Entity) => e.feature_id === entitlement.feature.id,
	);

	const hoverTexts = [
		{
			key: "Cus Ent ID",
			value: cusEnt.id,
		},
	];

	// NEW APPROACH: Check if cusEnt has internal_entity_id (entity-level loose entitlement)
	if (cusEnt.internal_entity_id) {
		const entity = entities.find(
			(e: Entity) => e.internal_id === cusEnt.internal_entity_id,
		);
		if (entity) {
			hoverTexts.push({
				key: "Entity",
				value: `${entity.id} (${entity.name})${entity.deleted ? " Deleted" : ""}`,
			});
		}
		// Always show internal_entity_id for debugging
		hoverTexts.push({
			key: "Internal Entity ID",
			value: cusEnt.internal_entity_id,
		});
	}
	// Check for per-entity features (features that ARE entity types)
	else if (featureEntities.length > 0) {
		hoverTexts.push({
			key: "Entities",
			value: featureEntities
				.map((e: Entity) => `${e.id} (${e.name})${e.deleted ? " Deleted" : ""}`)
				.join("\n"),
		});
	}
	// OLD APPROACH: entities object with per-entity balances
	else if (cusEnt.entities && Object.keys(cusEnt.entities).length > 0) {
		const mappedEntities = Object.keys(cusEnt.entities)
			.map((e: string) => {
				const entity = entities.find((ee: Entity) => ee.id === e);
				const balance = cusEnt.entities?.[e]?.balance;
				return `${entity?.id} (${entity?.name}): ${balance ?? "N/A"}`;
			})
			.join("\n");
		hoverTexts.push({
			key: "Entities",
			value: mappedEntities,
		});
	}

	const rollovers = cusEnt.rollovers ?? [];
	if (rollovers.length > 0) {
		hoverTexts.push({
			key: "Rollovers",
			value: rollovers
				.map((r: Rollover) => {
					const rolloverEntities = r.entities ? Object.values(r.entities) : [];
					if (rolloverEntities.length > 0) {
						return (
							rolloverEntities
								.map((e: EntityRolloverBalance) => `${e.balance} (${e.id})`)
								.join(", ") +
							` (expires: ${r.expires_at ? formatUnixToDate(r.expires_at) : "N/A"})`
						);
					} else {
						return `${r.balance} (ex: ${r.expires_at ? formatUnixToDate(r.expires_at) : "N/A"})`;
					}
				})
				.join("\n"),
		});
	}

	return hoverTexts;
};

export const getFeatureHoverTexts = ({ feature }: { feature: Feature }) => {
	const hoverTexts = [
		{
			key: "Internal ID",
			value: feature.internal_id || "",
		},
	];

	return hoverTexts;
};

export const getProductItemHoverTexts = ({
	item,
}: {
	item: ProductItem | null | undefined;
}) => [
	item?.entitlement_id
		? { key: "Entitlement ID", value: item.entitlement_id }
		: undefined,
	item?.price_id ? { key: "Price ID", value: item.price_id } : undefined,
	item?.price_config?.stripe_price_id
		? { key: "Stripe Price ID", value: item.price_config.stripe_price_id }
		: undefined,
	item?.price_config?.stripe_empty_price_id
		? {
				key: "Stripe Empty Price ID",
				value: item.price_config.stripe_empty_price_id,
			}
		: undefined,
	item?.price_config?.stripe_product_id
		? {
				key: "Stripe Product ID",
				value: item.price_config.stripe_product_id,
			}
		: undefined,
	item?.price_config?.stripe_prepaid_price_v2_id
		? {
				key: "Stripe Prepaid Price V2 ID",
				value: item.price_config.stripe_prepaid_price_v2_id,
			}
		: undefined,
];

export const getPlanHoverTexts = ({ plan }: { plan: Product | ProductV2 }) => {
	const hoverTexts = [
		{
			key: "Internal ID",
			value: plan.internal_id || "",
		},
	];

	if ("version" in plan && plan.version) {
		hoverTexts.push({
			key: "Version",
			value: plan.version.toString(),
		});
	}

	return hoverTexts;
};

export const getInvoiceHoverTexts = ({ invoice }: { invoice: Invoice }) => {
	const hoverTexts = [
		{
			key: "Invoice ID",
			value: invoice.id,
		},
		{
			key: "Stripe ID",
			value: invoice.stripe_id,
		},
	];

	return hoverTexts;
};
