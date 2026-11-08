import {
	AffectedResource,
	ApiVersion,
	applyResponseVersionChanges,
	CheckParamsSchema,
	CheckQuerySchema,
	type CheckResponseV3,
	ErrCode,
	isLockRequested,
	type ParsedCheckParams,
	RecaseError,
	RouteGroup,
	Scopes,
} from "@autumn/shared";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";
import {
	dependencyUnavailableBody,
	isDepFailClosed,
} from "@/internal/misc/dependencyPolicy/dependencyPolicy.js";
import { runCheckWithRollout } from "@/internal/balances/check/index.js";
import { parseCheckParamsForLock } from "@/internal/balances/utils/lock/parseCheckParamsForLock.js";
import { savePinnedQuote } from "@/internal/balances/track/utils/pinnedRatesStore.js";
import { getCheckFailOpenFallback } from "./checkUtils/getCheckFailOpenFallback.js";
import { getCheckPreview } from "./getCheckPreview.js";
import { handleProductCheck } from "./handlers/handleProductCheck.js";
import { resolveCheckPricing } from "./resolveCheckPricing.js";

const DEFAULT_REQUIRED_BALANCE = 1;
// check is the hottest-path route: past this budget we answer allowed rather
// than make the caller wait, no matter what work (locks included) is in flight.
const CHECK_FAIL_OPEN_TIMEOUT_MS = 3_000;

export const handleCheck = createRoute({
	scopes: [Scopes.Balances.Read],
	failOpen: {
		timeoutMs: CHECK_FAIL_OPEN_TIMEOUT_MS,
		// Lock checks must settle (the abandoned run would still create a lock
		// receipt → leaked reservation); product checks return a non-feature shape.
		skip: (c) => {
			const body = c.req.valid("json");
			return isLockRequested(body.lock) || Boolean(body.product_id);
		},
		respond: (c) => {
			const ctx = c.get("ctx");
			// Strict posture: a timed-out check sheds instead of admitting
			// without evaluation. Lock/product requests never reach here
			// (skip above). Direct response — the fail-open respond callback
			// runs detached after the race settled and must not throw.
			if (isDepFailClosed()) {
				return c.json(dependencyUnavailableBody({ ctx }), 503);
			}
			const body = parseCheckParamsForLock({ params: c.req.valid("json") });
			const response = getCheckFailOpenFallback({
				ctx,
				body,
				requiredBalance:
					body.required_balance ??
					body.required_quantity ??
					DEFAULT_REQUIRED_BALANCE,
				error: new Error(
					`check exceeded the ${CHECK_FAIL_OPEN_TIMEOUT_MS}ms blanket fail-open timeout`,
				),
				reason: "route_timeout",
			});
			return c.json(response, 202);
		},
	},
	routeGroup: RouteGroup.Balances,
	versionedQuery: {
		latest: CheckQuerySchema,
		[ApiVersion.V1_2]: CheckQuerySchema,
	},
	resource: AffectedResource.Check,
	body: CheckParamsSchema,
	handler: async (c) => {
		const rawBody = c.req.valid("json");
		const ctx = c.get("ctx");

		const body: ParsedCheckParams = parseCheckParamsForLock({
			params: rawBody,
		});

		const {
			customer_id,
			product_id,
			entity_id,
			required_quantity,
			required_balance,
			with_preview,
			model_id,
			input_tokens,
			output_tokens,
		} = body;

		// Legacy path - product check
		if (product_id) {
			const checkProductResult = await handleProductCheck({
				ctx: c.get("ctx"),
				body: { ...body, product_id }, // Ensure product_id is passed as string
			});
			return c.json(checkProductResult);
		}

		const requiredBalance =
			required_balance ?? required_quantity ?? DEFAULT_REQUIRED_BALANCE;

		// Price pinning: when the caller says which model it is about to use,
		// the response carries the unit rates it is admitted at.  The caller
		// passes them back on the settle call, so the reservation and the
		// charge are made at the same price even if the merchant edits their
		// price sheet in between.
		//
		// When a reservation is requested the pricing has to be resolved
		// BEFORE the check runs, because the hold is sized from it: a
		// reservation of the caller's policy floor (often $1.00) does not
		// bound a request that can cost $40, and N concurrent requests would
		// each see the whole balance.  A check without a reservation keeps the
		// old ordering and resolves pricing after the balance check.
		const needsPricingForHold = isLockRequested(body.lock) && Boolean(model_id);
		const holdPricing = needsPricingForHold
			? await resolveCheckPricing({
					ctx,
					modelId: model_id,
					inputTokens: input_tokens,
					outputTokens: output_tokens,
					featureId: body.feature_id,
				})
			: null;

		// Fail closed: a reserved request MUST have a priced hold.  Letting an
		// unpriceable model through reserves only the policy floor (every
		// concurrent request sees "balance − floor"), and the settle cannot
		// price it either — usage served, nothing billed.  The gateway's
		// require_lock turns the error into a 402 for the caller.
		if (needsPricingForHold && !holdPricing) {
			throw new RecaseError({
				message: `Model ${model_id} cannot be priced for this organization. Add it to the served models / price sheet before serving traffic.`,
				code: ErrCode.InvalidRequest,
				statusCode: 422,
			});
		}

		// Two different numbers, and they must not be conflated:
		//
		//   requiredBalance  the caller's minimum-balance policy -- the
		//                    balance a call may start with.
		//   lockValue        what this request can cost, priced at the org's
		//                    rates.  This is what the hold reserves, and it
		//                    is what bounds concurrent spend: the sum of all
		//                    outstanding holds can never exceed the balance.
		//
		// When the model cannot be priced there is no estimate to hold, and
		// the hold falls back to the policy floor.
		const lockValue =
			holdPricing && holdPricing.estimated_cost > 0
				? holdPricing.estimated_cost
				: undefined;

		const result = await runCheckWithRollout({
			ctx,
			body,
			requiredBalance,
			lockValue,
		});
		if (!result.checkData) {
			return c.json(result.response, 202);
		}

		const { checkData, response } = result;

		const pricing =
			holdPricing ??
			(await resolveCheckPricing({
				ctx,
				modelId: model_id,
				inputTokens: input_tokens,
				outputTokens: output_tokens,
				featureId: body.feature_id,
			}));

		// Persist the quote so the settle can only bill at rates the SERVER
		// issued (see pinnedRatesStore).  Bound to the caller's idempotency
		// key — the bridge sends litellm_call_id as both the check key and
		// the settle key, so a settle resolves the quote its check pinned.
		if (pricing && body.idempotency_key) {
			await savePinnedQuote({
				ctx,
				idempotencyKey: body.idempotency_key,
				pricing,
			});
		}

		const preview = with_preview
			? await getCheckPreview({
					ctx,
					checkResponse: response,
					checkData,
					customerId: customer_id,
					entityId: entity_id,
				})
			: undefined;

		// Version changes will transform V3 -> V2 -> V1 -> V0 based on target API version
		const transformedResponse = applyResponseVersionChanges<CheckResponseV3>({
			input: response,
			targetVersion: ctx.apiVersion,
			resource: AffectedResource.Check,
			legacyData: {
				noCusEnts:
					checkData.apiBalance === undefined && checkData.apiFlag === undefined,
				featureToUse: checkData.featureToUse,
			},
			ctx,
		});

		return c.json({
			...transformedResponse,
			preview,
			...(pricing ? { pricing } : {}),
			// The reservation taken for this request.  Added after the version
			// transform so it survives every API version: without it the
			// caller has no id to finalize and the hold can only be released
			// by its expiry.
			...(response.lock ? { lock: response.lock } : {}),
		});
	},
});
