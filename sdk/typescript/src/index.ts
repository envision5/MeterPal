// @meterpal/sdk — customer-facing billing components + client for MeterPal
// (PayPal-native AI usage billing).
//
// Requires the host app to wrap its tree in <AutumnProvider> from
// "autumn-js/react" and to mount the autumn-js/backend routes server-side
// (secret key stays on the server).
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
