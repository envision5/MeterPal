import type {
	FullCusEntWithFullCusProduct,
	FullCusProduct,
} from "@autumn/shared";

export const cusProductToCusEnt = ({
	cusProduct,
	featureId,
}: {
	cusProduct: FullCusProduct;
	featureId: string;
}) => {
	const cusEnts = cusProduct.customer_entitlements;

	const fullCusEnt = cusEnts.find(
		(ce) => ce.entitlement.feature.id === featureId,
	);

	if (fullCusEnt) {
		return {
			...fullCusEnt,
			customer_product: cusProduct,
		} as FullCusEntWithFullCusProduct;
	}

	return undefined;
};
