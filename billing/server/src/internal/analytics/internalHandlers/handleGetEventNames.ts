import { type Feature, FeatureType, Scopes } from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import { eventActions } from "../actions/eventActions.js";

/**
 * Get top event names for the organization
 */
export const handleGetEventNames = createRoute({
	scopes: [Scopes.Analytics.Read],
	handler: async (c) => {
		const ctx = c.get("ctx");
		const { features } = ctx;

		// The analytics read path serves from Tinybird when it is configured and
		// from Postgres otherwise, so there are always event names to report.

		const res = await eventActions.getTopEventNames({ ctx });
		const result = res.eventNames;

		const featureIds: string[] = [];
		const eventNames: string[] = [];

		for (let i = 0; i < result.length; i++) {
			// Is an event name
			if (
				features.some(
					(feature: Feature) =>
						feature.type === FeatureType.Metered &&
						feature.event_names &&
						feature.event_names.includes(result[i]),
				)
			) {
				eventNames.push(result[i]);
			} else if (
				features.some((feature: Feature) => feature.id === result[i])
			) {
				featureIds.push(result[i]);
			}

			if (i >= 2) break;
		}

		return c.json({
			featureIds,
			eventNames,
		});
	},
});
