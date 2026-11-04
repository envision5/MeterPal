import { featureOptionsAreSame } from "@utils/cusProductUtils/featureOptionUtils/compareFeatureOptions/featureOptionsAreSame";
import { featureOptionsToCustomerEntitlement } from "@utils/cusProductUtils/featureOptionUtils/convertFeatureOptions/featureOptionsToCustomerEntitlement";
import { featureOptionsToPrice } from "@utils/cusProductUtils/featureOptionUtils/convertFeatureOptions/featureOptionsToPrice";

export const featureOptionUtils = {
	compare: {
		areSame: featureOptionsAreSame,
	},
	convert: {
		toPrice: featureOptionsToPrice,
		toCustomerEntitlement: featureOptionsToCustomerEntitlement,
	},
};
