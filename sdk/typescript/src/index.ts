// @meterpal/sdk — customer-facing billing components + inference client for
// MeterPal (PayPal-native AI usage billing).
//
// Two halves, usable together or apart:
//
//   * The inference client (server-side).  One OpenAI-shaped call, billed to
//     the end user:
//       import { createMeterPal } from "@meterpal/sdk";
//       const meterpal = createMeterPal({ apiKey: process.env.METERPAL_SECRET_KEY });
//       const completion = await meterpal.chat.completions.create({
//         model: "custom/demo-gpt",
//         messages: [{ role: "user", content: "hi" }],
//         user: "cus_123",
//       });
//
//   * The React components (browser-side).  They read credits, plans and
//     usage through the host app's backend routes, so the secret key never
//     ships to the browser.
//
// The components need the host app to wrap its tree in <AutumnProvider> from
// "autumn-js/react" and to mount the autumn-js/backend routes server-side.
export { CreditsBadge } from "./components/CreditsBadge";
export { LowBalanceBanner } from "./components/LowBalanceBanner";
export { PlanCard } from "./components/PlanCard";
export { TopUpModal } from "./components/TopUpModal";
export { UsageHistoryPanel } from "./components/UsageHistoryPanel";
export { CostTooltip } from "./components/CostTooltip";
export { createMeterPalClient, createBillingClient } from "./client";
export type {
	MeterPalClient,
	MeterPalClientConfig,
	BillingClientConfig,
} from "./client";

// ---- inference client ----
export { createMeterPal, DEFAULT_BASE_URL } from "./inference/client";
export type {
	MeterPal,
	MeterPalConfig,
	FetchLike,
	TopUpOptions,
} from "./inference/client";
export {
	MeterPalError,
	AuthenticationError,
	InsufficientBalanceError,
	ModelNotEnabledError,
	ModelNotFoundError,
	RateLimitError,
	CustomerNotFoundError,
	APIError,
	ConnectionError,
} from "./inference/errors";
export type {
	Catalog,
	ChatCompletion,
	ChatCompletionChoice,
	ChatCompletionChunk,
	ChatCompletionChunkChoice,
	ChatCompletionRequest,
	ChatMessage,
	ChatRole,
	MeterpalBlock,
	ServedModel,
	TopUpResult,
	Usage,
} from "./inference/types";
