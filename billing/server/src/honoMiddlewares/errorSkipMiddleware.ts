import { ErrCode, RecaseError } from "@autumn/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod/v4";
import { formatZodError } from "@/errors/formatZodError.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { matchRoute } from "./middlewareUtils.js";

// ============================================================================
// ERROR SKIP CONFIGURATION
// ============================================================================

/**
 * Simple route-based error code skipping
 * Add routes here to skip specific error codes (logged as warnings, returns appropriate status)
 */
const ROUTE_ERROR_SKIP_MAP = [
	// {
	// 	route: "/products/:productId/count",
	// 	method: "GET",
	// 	skipErrorCodes: [ProductErrorCode.ProductNotFound],
	// },
	{
		route: "/customers/:customer_id/aksdjnalksjnd",
		method: "GET",
		skipErrorCodes: [ErrCode.CustomerNotFound],
	},
] as const;

// /** Global error codes that should be logged as warnings instead of errors (all routes) */
// const GLOBAL_WARN_ERROR_CODES: string[] = [
// 	ProductErrorCode.ProductNotFound,
// 	CusErrorCode.CustomerNotFound,
// 	ErrCode.CustomerNotFound,
// 	ErrCode.EntityNotFound,
// ];

/** Advanced route-specific error handling rules (for complex matching logic) */
const ROUTE_SPECIFIC_RULES: Array<{
	name: string;
	match: (err: Error, c: Context<HonoEnv>) => boolean;
	statusCode: ContentfulStatusCode;
}> = [];

/** Zod-specific error handling rules */
const ZOD_RULES = [
	{
		name: "Zod user input validation error",
		match: (err: Error, c: Context<HonoEnv>) =>
			err instanceof ZodError && !c.get("validated"),
		statusCode: 400,
		format: (err: ZodError) => formatZodError(err),
	},
] as const;

const createErrorResponse = ({
	c,
	ctx,
	message,
	code,
	statusCode,
}: {
	c: Context<HonoEnv>;
	ctx: any;
	message: string;
	code: string;
	statusCode: ContentfulStatusCode;
}) => {
	if (statusCode === 503) c.header("Retry-After", "1");
	return c.json(
		{
			message,
			code,
			env: ctx.env,
		},
		statusCode,
	);
};

/**
 * Handles special error cases that should use warn logging instead of error logging.
 * Returns a response if handled, null otherwise to continue to main error handler.
 */
export const handleErrorSkip = (err: Error, c: Context<HonoEnv>) => {
	const ctx = c.get("ctx");
	const logger = ctx?.logger;

	if (!logger) return null; // Let main error handler deal with this

	// 1. Check route-based error code skipping (simplest case)
	if (err instanceof RecaseError) {
		const pathname = new URL(c.req.url).pathname;

		for (const skipRule of ROUTE_ERROR_SKIP_MAP) {
			if (
				skipRule.skipErrorCodes.includes(err.code as any) &&
				matchRoute({
					url: pathname,
					method: c.req.method,
					pattern: { url: skipRule.route, method: skipRule.method },
				})
			) {
				logger.warn(
					`${err.message}, org: ${ctx.org?.slug || "unknown"} [route skip: ${skipRule.route}]`,
				);
				return createErrorResponse({
					c,
					ctx,
					message: err.message,
					code: err.code,
					statusCode: 404,
				});
			}
		}
	}

	// 2. Check advanced route-specific rules
	for (const rule of ROUTE_SPECIFIC_RULES) {
		if (rule.match(err, c)) {
			const errorCode =
				err instanceof RecaseError ? err.code : ErrCode.InternalError;
			logger.warn(`${rule.name}, org: ${ctx.org?.slug || "unknown"}`);
			return createErrorResponse({
				c,
				ctx,
				message: err.message,
				code: errorCode,
				statusCode: rule.statusCode,
			});
		}
	}

	// 3. Check Zod-specific rules
	for (const rule of ZOD_RULES) {
		if (rule.match(err, c)) {
			const zodErr = err as ZodError;
			const formattedError = rule.format(zodErr);
			logger.warn(
				`ZOD ERROR (${ctx.org?.slug || "unknown"}): ${formattedError}`,
			);
			return createErrorResponse({
				c,
				ctx,
				message: formattedError,
				code: ErrCode.InvalidInputs,
				statusCode: rule.statusCode,
			});
		}
	}

	// No special case matched - continue to main error handler
	return null;
};
