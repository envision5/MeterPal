import { z } from "zod/v4";
import { CustomerDataSchema } from "../../common/customerData";
import { EntityDataSchema } from "../../common/entityData";
import { OverageBehaviorSchema } from "./overageBehavior";
import { TrackTimestampSchema } from "./trackTimestamp";

export const TrackTokensParamsSchema = z.object({
	customer_id: z.string().meta({
		description: "The ID of the customer.",
	}),
	entity_id: z.string().optional().meta({
		description: "The ID of the entity for entity-scoped balances.",
	}),
	feature_id: z.string().optional().meta({
		description:
			"The ID of the AI credit system feature. Auto-detected from the customer's entitlements if omitted — only required when a customer has multiple AI credit systems.",
	}),
	model_id: z.string().meta({
		description:
			"The AI model as '[provider]/[model]' (e.g. 'anthropic/claude-opus-4-8', 'openrouter/openai/gpt-4o'). The provider is the first path segment and must match a provider + model key in models.dev.",
	}),
	input_tokens: z.number().int().nonnegative().meta({
		description:
			"Number of non-cached text input tokens consumed. Exclusive of cache and audio token pools.",
	}),
	output_tokens: z.number().int().nonnegative().meta({
		description:
			"Number of text output tokens consumed. Exclusive of the reasoning and audio output pools.",
	}),
	cache_read_tokens: z.number().int().nonnegative().optional().meta({
		description: "Number of cached input tokens read.",
	}),
	cache_write_tokens: z.number().int().nonnegative().optional().meta({
		description: "Number of input tokens written to the cache.",
	}),
	audio_input_tokens: z.number().int().nonnegative().optional().meta({
		description: "Number of audio input tokens consumed.",
	}),
	audio_output_tokens: z.number().int().nonnegative().optional().meta({
		description: "Number of audio output tokens generated.",
	}),
	reasoning_tokens: z.number().int().nonnegative().optional().meta({
		description: "Number of reasoning tokens generated.",
	}),
	properties: z.record(z.string(), z.any()).optional().meta({
		description: "Additional properties to attach to this usage event.",
	}),
	idempotency_key: z.string().optional().meta({
		internal: true,
	}),
	// The gateway names the tenant it resolved from the caller's virtual key.
	// These are read off the raw request body by the gateway auth middleware;
	// declaring them here keeps the contract explicit instead of relying on
	// the body carrying fields the schema does not mention.
	org_id: z.string().optional().meta({
		internal: true,
	}),
	env: z.string().optional().meta({
		internal: true,
	}),
	timestamp: TrackTimestampSchema.optional(),
	overage_behavior: OverageBehaviorSchema.optional(),
	customer_data: CustomerDataSchema.optional().meta({
		internal: true,
	}),
	entity_data: EntityDataSchema.optional().meta({
		internal: true,
	}),
	skip_event: z.boolean().optional().meta({
		internal: true,
	}),
	async: z.boolean().optional().meta({
		description:
			"If true, enqueue the event for asynchronous processing and return 204 immediately. The response will not include balance information.",
	}),
	pinned_rates: z
		.object({
			input: z.number(),
			output: z.number(),
			cache_read: z.number().optional(),
			cache_write: z.number().optional(),
			audio_input: z.number().optional(),
			audio_output: z.number().optional(),
			reasoning: z.number().optional(),
			markup: z.number(),
		})
		.refine(
			(rates) => Object.values(rates).every((v) => Number.isFinite(v) && v >= 0),
			{
				message:
					"pinned_rates must be finite, non-negative numbers. They are advisory — the server only honors rates it issued at check time.",
			},
		)
		.optional()
		.meta({
			description:
				"The unit prices returned by an earlier check for the same model. The server honors these only when they match the quote it stored at check time under the same idempotency key; otherwise the charge is computed from the org's current price sheet.",
		}),
});

export type TrackTokensParams = z.infer<typeof TrackTokensParamsSchema>;

export const BatchTrackTokensParamsSchema = z
	.array(TrackTokensParamsSchema)
	.min(1)
	.max(1000);

export type BatchTrackTokensParams = z.infer<
	typeof BatchTrackTokensParamsSchema
>;
