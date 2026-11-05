import { ErrCode, RecaseError } from "@autumn/shared";
import * as Sentry from "@sentry/bun";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod/v4";
import { formatZodError } from "@/errors/formatZodError.js";
import type { HonoEnv } from "@/honoUtils/HonoEnv.js";
import { getSentryTags } from "../external/sentry/sentryUtils.js";
import { handleErrorSkip } from "./errorSkipMiddleware.js";
/**
 * Hono error handler middleware
 * Handles different error types and responds appropriately with proper logging
 */
export const errorMiddleware = (err: Error, c: Context<HonoEnv>) => {
	const ctx = c.get("ctx");
	const logger = ctx?.logger;

	// 1. Handle RecaseError (our custom errors) — these are expected user-facing
	// errors, so warn-log and respond WITHOUT capturing to Sentry.
	// This runs before the no-context fallback: some routes (e.g. /api/auth/*)
	// are registered before baseMiddleware, so `ctx` is never set there, and
	// without this branch their expected 401s surfaced as 500s.
	if (err instanceof RecaseError) {
		if (logger) {
			logger.warn(
				`RECASE WARNING (${ctx.org?.slug || "unknown"}): ${err.message} [${err.code}]`,
				{
					error: err.data ?? err,
				},
			);
		} else {
			console.warn(
				`RECASE WARNING (no context): ${err.message} [${err.code}]`,
			);
		}

		if (err.statusCode === 503) c.header("Retry-After", "1");
		return c.json(
			{
				message: err.message,
				code: err.code,
				...(ctx?.env ? { env: ctx.env } : undefined),
			},
			err.statusCode as ContentfulStatusCode,
		);
	}

	// If no context/logger available, fallback to console
	if (!logger) {
		console.error("Error occurred before context was set:", err);
		Sentry.captureException(err);
		return c.json(
			{
				message: "Internal server error",
				code: ErrCode.InternalError,
			},
			500,
		);
	}

	// Check for error skip cases first (warn-level errors that don't need Sentry)
	const skipResponse = handleErrorSkip(err, c);
	if (skipResponse) return skipResponse;

	// If we got here, it's an error worth tracking - capture to Sentry
	Sentry.captureException(err, {
		tags: getSentryTags({
			ctx,
			path: c.req.path,
			method: c.req.method,
		}),
	});

	// 2. Handle Zod validation errors
	// Note: User input validation errors are already handled by errorSkipMiddleware
	// If we get here, it's an internal Zod error (bug in our code)
	if (err instanceof ZodError) {
		const formattedError = formatZodError(err);

		logger.error(
			`INTERNAL ZOD ERROR (${ctx.org?.slug || "unknown"}): ${formattedError}`,
		);
		logger.error(err);

		// Details go to the logs and Sentry above — the response stays
		// generic so an internal bug (schema shapes, table names) does not
		// become client-side reconnaissance.
		return c.json(
			{
				message: "Internal server error",
				code: ErrCode.InternalError,
			},
			500,
		);
	}

	// 3. Handle unknown errors
	logger.error(
		`UNKNOWN ERROR (${ctx.org?.slug || "unknown"}): ${err.message}`,
		{
			error: {
				stack: err.stack,
				message: err.message,
			},
		},
	);

	// The raw error message (Drizzle/PG internals, provider responses, stack
	// fragments) must not reach the client on an unexpected 500 — expected,
	// user-facing errors are RecaseErrors handled above.
	return c.json(
		{
			message: "Internal server error",
			code: ErrCode.InternalError,
		},
		500,
	);
};
