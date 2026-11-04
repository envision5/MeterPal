import { z } from "zod/v4";

export const ApiFeatureProcessorsSchema = z
	.object({})
	.meta({ "x-atmn-mapping": true });

export type ApiFeatureProcessors = z.infer<typeof ApiFeatureProcessorsSchema>;
