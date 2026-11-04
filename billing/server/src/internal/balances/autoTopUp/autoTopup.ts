import { AppEnv, ms } from "@autumn/shared";
import {
	clearAutoTopupPendingKey,
	keepAutoTopupPendingKey,
} from "@/external/redis/actions/autoTopUpSuppression/autoTopUpSuppression.js";
import { withLock } from "@/external/redis/utils/lockUtils/withLock.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { AutoTopUpPayload } from "@/queue/workflows.js";
import type { AutoTopupAttemptContext } from "./autoTopupContext.js";
import { buildAutoTopUpLockKey } from "./helpers/autoTopUpUtils.js";
import {
	maybeGetPaypalAutoTopupCustomer,
	runPaypalAutoTopup,
} from "./paypal/paypalAutoTopup.js";
import {
	classifyAutoTopupError,
	sendAutoTopupFailedWebhook,
} from "./webhooks/sendAutoTopupFailedWebhook.js";

// Must outlive the queue's full retry chain (maxReceiveCount 10 × 30s visibility = 5m),
// else the gate reopens while copies still cycle and track traffic reseeds the storm.
const AUTO_TOPUP_RETRY_SUPPRESSION_MS = ms.minutes(10);

/** Workflow handler for auto top-ups. */
export const autoTopup = async ({
	ctx,
	payload,
}: {
	ctx: AutumnContext;
	payload: AutoTopUpPayload;
}) => {
	const { org, env, logger } = ctx;
	const { customerId, featureId } = payload;
	let failureWebhookSent = false;
	let lastAutoTopupContext: AutoTopupAttemptContext | undefined;
	let pendingTtlMs: number | undefined;

	const sendFailureWebhook = async ({
		autoTopupContext,
		...failure
	}: Omit<
		Parameters<typeof sendAutoTopupFailedWebhook>[0],
		"ctx" | "customerId" | "featureId"
	>) => {
		failureWebhookSent = true;
		await sendAutoTopupFailedWebhook({
			ctx,
			customerId,
			featureId,
			autoTopupContext,
			...failure,
		});
	};

	const executeAutoTopup = async () => {
		const start = performance.now();

		logger.info(
			`========= RUNNING AUTO TOPUP FOR CUSTOMER ${customerId} AND FEATURE ${featureId} ========`,
		);

		if (org.config.disabled_auto_topup && env === AppEnv.Live) {
			const message = `Auto top-up is disabled for organization ${org.id}, skipping`;
			logger.info(`[autoTopup] ${message}`);
			return;
		}

		// The instrument is the customer's vaulted PayPal billing agreement,
		// charged merchant-initiated through Orders v2 (paypalAutoTopup.ts).
		// Customers without one have nothing to charge.
		const paypalCustomer = await maybeGetPaypalAutoTopupCustomer({
			ctx,
			customerId,
		});
		if (!paypalCustomer) {
			logger.info(
				`[autoTopup] Customer ${customerId} has no PayPal billing agreement, skipping`,
			);
			return;
		}

		await runPaypalAutoTopup({
			ctx,
			payload,
			fullCustomer: paypalCustomer,
		});

		const durationMs = Math.round(performance.now() - start);
		logger.info(
			`[autoTopup] Completed for feature ${featureId}, customer ${customerId}, duration: ${durationMs}ms`,
		);
	};

	try {
		// Execute under lock (shares attach lock to prevent concurrent attach + auto-topup)
		await withLock({
			lockKey: buildAutoTopUpLockKey({
				orgId: org.id,
				env,
				customerId,
			}),
			ttlMs: ms.minutes(5),
			errorMessage: `Another billing operation is already in progress for customer ${customerId}`,
			fn: executeAutoTopup,
		});
	} catch (error) {
		const failure = classifyAutoTopupError({ error });
		if (failure.reason === "lock_contention") {
			pendingTtlMs = AUTO_TOPUP_RETRY_SUPPRESSION_MS;
		} else if (!failureWebhookSent) {
			await sendFailureWebhook({
				...failure,
				error,
				autoTopupContext: lastAutoTopupContext,
			});
		}
		throw error;
	} finally {
		if (pendingTtlMs) {
			await keepAutoTopupPendingKey({
				ctx,
				customerId,
				featureId,
				ttlMs: pendingTtlMs,
			});
		} else {
			await clearAutoTopupPendingKey({ ctx, customerId, featureId });
		}
	}
};
