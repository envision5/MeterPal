import { BasePriceParamsSchema } from "@api/products/components/basePrice/basePrice.js";
import type { z } from "zod/v4";

/**
 * The base price params plus processor price adoption. Adoption is scoped to the
 * catalog path: `validateAdoptedProcessorPrices` only runs in the catalogV2 init
 * flow, so a stated price id on attach/customize/migration would be persisted
 * unchecked and only surface as a processor error at checkout. Keep `processors`
 * here rather than on `BasePriceParamsSchema`.
 */
export const CatalogBasePriceParamsSchema = BasePriceParamsSchema.extend({
}).meta({
	title: "CatalogBasePrice",
	description:
		"Base price configuration for a catalog plan, including processor price adoption.",
});

export type CatalogBasePriceParams = z.infer<
	typeof CatalogBasePriceParamsSchema
>;
export type CatalogBasePriceParamsInput = z.input<
	typeof CatalogBasePriceParamsSchema
>;
