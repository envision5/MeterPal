import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod/v4";

/**
 * The schema type `@hono/zod-validator` accepts.
 *
 * The workspace resolves two zod copies: this package's `zod/v4` comes from
 * zod@3.25.x while the validator's `zod/v4/core` comes from zod@4, so the two
 * `$ZodType` declarations are structurally incompatible. The validator is
 * runtime-version-agnostic (it only calls `safeParseAsync`), so the cast is
 * type-level only.
 */
type ZodValidatorSchema = Parameters<typeof zValidator>[1];

/**
 * Custom validator that wraps @hono/zod-validator with error throwing behavior
 * This allows the errorMiddleware to handle validation errors consistently
 * Maintains full type inference from zValidator
 *
 * For query validation, this uses the parsed query from queryMiddleware
 * to ensure boolean/array conversions are applied before validation
 *
 * For JSON validation, empty bodies are treated as {} to allow optional body schemas
 *
 * Usage:
 * ```ts
 * router.post(
 *   "/products",
 *   validator("json", CreateProductSchema),
 *   async (c) => {
 *     const body = c.req.valid("json"); // Fully typed!
 *     // ... handler logic
 *   }
 * );
 * ```
 */
export const validator = <T extends ZodType>(
	target: "json" | "query" | "param" | "header" | "form",
	schema: T,
) => {
	// For query validation, use the parsed query from queryMiddleware
	if (target === "query") {
		return async (c: any, next: any) => {
			const parsedQuery = c.req.query();
			const result = schema.safeParse(parsedQuery);
			if (!result.success) {
				throw result.error;
			}
			// Store validated data for c.req.valid("query")
			c.req.addValidatedData(target, result.data);
			await next();
		};
	}

	// Handle JSON body - allow empty body if schema allows it
	if (target === "json") {
		return async (c: any, next: any) => {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				// Empty body or whitespace-only body - default to empty object
				// Real JSON parse errors will still fail schema validation
				body = {};
			}

			// If body is null/undefined, default to empty object
			if (body === null || body === undefined) {
				body = {};
			}

			const result = schema.safeParse(body);
			if (!result.success) {
				throw result.error;
			}
			c.req.addValidatedData(target, result.data);
			await next();
		};
	}

	return zValidator(
		target,
		schema as unknown as ZodValidatorSchema,
		(result, _c) => {
			if (!result.success) {
				throw result.error;
			}
		},
	);
};
