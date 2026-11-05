import { z } from "zod/v4";

export const LockParamsSchema = z.object({
	lock_id: z.string().max(256).meta({
		description:
			"A unique identifier for this lock. Used to finalize the lock later via balances.finalize.",
	}),
	enabled: z.literal(true).meta({
		description: "Must be true to enable locking.",
	}),
	hashed_key: z.string().optional().meta({
		internal: true,
	}),
	expires_at: z.number().optional().meta({
		description:
			"Unix timestamp (ms) when the lock automatically expires and releases the held balance.",
	}),
});

// "reject" is the default and stays internal like on track, so public docs
// only surface "cap" and "overflow" as opt-ins.
export const LockOverageBehaviorSchema = z
	.union([
		z.enum(["cap", "overflow"]),
		z.enum(["reject"]).meta({ internal: true }),
	])
	.meta({
		description:
			'How to handle a lock that exceeds the available balance. "reject" (default) returns allowed: false and reserves nothing. "cap" reserves only what fits and returns allowed: true. "overflow" reserves the full value: the balance can go negative, though spend limits still apply. balances.finalize reuses the behavior chosen here.',
	});

export const CheckLockParamsSchema = LockParamsSchema.extend({
	// The server mints the id when the caller does not name one, so a caller
	// that only wants "reserve for me" does not have to invent one.
	lock_id: z.string().max(256).optional().meta({
		description:
			"A unique identifier for this lock. Used to finalize the lock later via balances.finalize. Optional on check: the server mints one when it is omitted.",
	}),
	overage_behavior: LockOverageBehaviorSchema.optional(),
});

export const ParsedLockParamsSchema = CheckLockParamsSchema.extend({
	lock_id: z.string().max(256),
	hashed_key: z.string(),
});

/**
 * The `lock` field as a caller may send it on a check.
 *
 * `false` (or absent) disables locking; `true` is shorthand for
 * `{ enabled: true }`; the object form carries the options.  The boolean
 * shorthand exists because it is the form the gateway and the published
 * docs use, and a reservation that 400s is worse than no reservation at
 * all -- the caller cannot tell that the hold never happened.
 */
export const CheckLockRequestSchema = z.union([
	z.boolean(),
	CheckLockParamsSchema,
]);

/**
 * Whether the caller asked for a reservation.
 *
 * Handles the boolean shorthand, so a caller that sends `lock: true` gets
 * the same treatment as one that sends `lock: { enabled: true }`.
 */
export const isLockRequested = (
	lock: z.infer<typeof CheckLockRequestSchema> | undefined,
): boolean => (typeof lock === "boolean" ? lock : Boolean(lock?.enabled));

export type LockParams = z.infer<typeof LockParamsSchema>;
export type LockOverageBehavior = z.infer<typeof LockOverageBehaviorSchema>;
export type CheckLockParams = z.infer<typeof CheckLockParamsSchema>;
export type ParsedLockParams = z.infer<typeof ParsedLockParamsSchema>;
export type CheckLockRequest = z.infer<typeof CheckLockRequestSchema>;
