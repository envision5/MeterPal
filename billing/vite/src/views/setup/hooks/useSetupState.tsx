// billing/vite/src/views/setup/hooks/useSetupState.tsx
//
// The MeterPal setup wizard's state.
//
// One endpoint, because the wizard's five steps all read the same facts:
// what PayPal connection exists, which plans are sellable, what the price
// sheet says, and whether the smoke test has ever run.
//
// The state is what is TRUE, read from the tables the product runs on -- not
// a checklist the wizard keeps for itself.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useEnv } from "@/utils/envUtils";

export interface SetupPaypal {
	connected: boolean;
	/** True when the org bills through the platform's shared PayPal account. */
	shared_account: boolean;
	client_id: string | null;
	/** The PayPal account the connection acts on behalf of. */
	account_email: string | null;
	webhook_id: string | null;
	connected_at: number | null;
	/** "sandbox" or "live". */
	paypal_env: "sandbox" | "live";
}

export interface SetupPlan {
	product_id: string;
	name: string;
	/** What the plan costs, in USD. Null when it has no fixed price. */
	amount_usd: number | null;
	/** The billing interval, e.g. "month". */
	interval: string | null;
	/** The PayPal plan that bills it. Null until one is created. */
	paypal_plan_id: string | null;
	paypal_product_id: string | null;
}

export interface SetupModel {
	model_id: string;
	display_name: string | null;
	upstream_model: string | null;
	enabled: boolean;
	input_cost_usd_1m: number | null;
	output_cost_usd_1m: number | null;
	markup_pct: number | null;
}

export interface SetupSmokeTest {
	credits_charged: number | null;
	balance_after: number | null;
	model_id: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	ran_at: number;
}

export interface SetupState {
	env: string;
	paypal: SetupPaypal;
	plans: SetupPlan[];
	models: SetupModel[];
	install: {
		api_url: string;
		keys_url: string;
	};
	smoke_test: SetupSmokeTest | null;
}

export interface SmokeTestResult {
	customer_id: string;
	model_id: string;
	upstream_model: string;
	reply: string | null;
	meterpal: {
		credits_charged: number | null;
		balance_after: number | null;
		customer_id: string;
		model_id: string | null;
		input_tokens: number | null;
		output_tokens: number | null;
	};
}

/**
 * Setup is complete when every wizard step reads done from the product:
 * PayPal connected, a plan PayPal can bill, a model enabled, and a smoke
 * test that actually ran. Mirrors the per-step completion in SetupView, so
 * the sidebar can hide the entry for the same state the wizard shows.
 */
export const isSetupComplete = (state: SetupState | undefined): boolean =>
	!!state &&
	state.paypal.connected &&
	(state.plans ?? []).some(
		(plan) => plan.amount_usd != null && plan.paypal_plan_id != null,
	) &&
	(state.models ?? []).some((model) => model.enabled) &&
	state.smoke_test != null;

/**
 * Sidebar-sized view of the wizard state: true only once setup is complete.
 * Shares the wizard's query key, so completing a step in the wizard (or
 * connecting PayPal in settings) updates the sidebar through the same cache.
 */
export const useSetupComplete = () => {
	const { state } = useSetupState();
	return isSetupComplete(state);
};

export const useSetupState = () => {
	const axiosInstance = useAxiosInstance();
	const buildKey = useQueryKeyFactory();
	const queryClient = useQueryClient();
	const env = useEnv();

	const stateKey = buildKey(["setup-state", env]);

	const state = useQuery<SetupState>({
		queryKey: stateKey,
		queryFn: async () => {
			const { data } = await axiosInstance.get<SetupState>("/organization/setup");
			return data;
		},
	});

	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: stateKey });
	};

	const createPaypalPlan = useMutation({
		mutationFn: async (productId: string) => {
			const { data } = await axiosInstance.post<{
				product_id: string;
				paypal_plan_id: string;
			}>("/organization/setup/paypal-plan", { product_id: productId });
			return data;
		},
		onSuccess: invalidate,
	});

	const runSmokeTest = useMutation({
		mutationFn: async (model?: string) => {
			const { data } = await axiosInstance.post<SmokeTestResult>(
				"/organization/setup/smoke-test",
				model ? { model } : {},
			);
			return data;
		},
		onSuccess: invalidate,
	});

	return {
		state: state.data,
		isLoading: state.isLoading,
		error: state.error,
		refetch: state.refetch,
		createPaypalPlan: createPaypalPlan.mutateAsync,
		isCreatingPlan: createPaypalPlan.isPending,
		runSmokeTest: runSmokeTest.mutateAsync,
		isRunningSmokeTest: runSmokeTest.isPending,
	};
};
