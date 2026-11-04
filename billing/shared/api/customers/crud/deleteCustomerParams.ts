import { CustomerIdSchema } from "@api/common/customerId";
import { z } from "zod/v4";

export const DeleteCustomerParamsSchema = z.object({
	customer_id: CustomerIdSchema.describe("ID of the customer to delete"),
});

export const DeleteCustomerResponseSchema = z.object({
	success: z.boolean(),
});

export type DeleteCustomerParams = z.infer<typeof DeleteCustomerParamsSchema>;
export type DeleteCustomerResponse = z.infer<
	typeof DeleteCustomerResponseSchema
>;
