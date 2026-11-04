import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useEnv } from "@/utils/envUtils";

/** One instance behind a served model: a provider account and key. The key
 *  itself never comes back — only its last four characters, and the extra
 *  params only as their key names (the values can hold provider secrets). */
export interface ServedModelDeployment {
	id: string;
	provider_model: string;
	api_base: string | null;
	api_key_hint: string;
	rpm: number | null;
	tpm: number | null;
	timeout: number | null;
	max_retries: number | null;
	weight: number | null;
	/** LiteLLM's `order` — lower orders are tried first. */
	order: number | null;
	organization: string | null;
	extra_params_keys: string[];
	created_at?: number | null;
}

export interface ServedModel {
	model_id: string;
	display_name: string | null;
	upstream_model: string | null;
	enabled: boolean;
	/** The merchant's price, USD per 1M tokens. */
	input_cost_usd_1m: number | null;
	output_cost_usd_1m: number | null;
	/** The merchant's markup, in percent. Null = inherit the plan's markup. */
	markup_pct: number | null;
	updated_at?: number | null;
	deployments?: ServedModelDeployment[];
}

export interface AvailableModel {
	model_id: string;
	display_name: string | null;
	/** The PROVIDER's price, USD per 1M — the baseline for the margin preview. */
	provider_input_cost_usd_1m: number | null;
	provider_output_cost_usd_1m: number | null;
	source: "provider" | "custom" | "served";
}

export interface ServedModelUpdate {
	model_id: string;
	display_name?: string | null;
	upstream_model?: string | null;
	enabled?: boolean;
	input_cost_usd_1m?: number | null;
	output_cost_usd_1m?: number | null;
	markup_pct?: number | null;
}

/** An instance to register on the gateway. On update, an empty or absent
 *  `api_key` keeps the stored one, and an absent `extra_params` keeps the
 *  stored blob (an explicit `{}` clears it). */
export interface DeploymentUpdate {
	provider_model?: string;
	api_key?: string;
	api_base?: string | null;
	rpm?: number | null;
	tpm?: number | null;
	timeout?: number | null;
	max_retries?: number | null;
	weight?: number | null;
	order?: number | null;
	organization?: string | null;
	extra_params?: Record<string, unknown>;
}

/** The org's price sheet, and the models it can pick from. */
export const useServedModelsQuery = () => {
	const axiosInstance = useAxiosInstance();
	const buildKey = useQueryKeyFactory();
	const queryClient = useQueryClient();
	const env = useEnv();

	const listKey = buildKey(["served-models", env]);
	const availableKey = buildKey(["served-models", "available", env]);

	const list = useQuery<{ models: ServedModel[] }>({
		queryKey: listKey,
		queryFn: async () => {
			const { data } = await axiosInstance.get<{ models: ServedModel[] }>(
				"/v1/served_models",
			);
			return data;
		},
	});

	const available = useQuery<{ models: AvailableModel[] }>({
		queryKey: availableKey,
		queryFn: async () => {
			const { data } = await axiosInstance.get<{ models: AvailableModel[] }>(
				"/v1/served_models/available",
			);
			return data;
		},
		staleTime: 5 * 60 * 1000,
	});

	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: listKey });
		// A new custom/ model only exists in "available" through this list.
		queryClient.invalidateQueries({ queryKey: availableKey });
	};

	const upsert = useMutation({
		mutationFn: async (update: ServedModelUpdate) => {
			const { data } = await axiosInstance.post<{ model: ServedModel }>(
				"/v1/served_models",
				update,
			);
			return data.model;
		},
		onSuccess: invalidate,
	});

	const remove = useMutation({
		mutationFn: async (modelId: string) => {
			await axiosInstance.delete(`/v1/served_models/${encodeURIComponent(modelId)}`);
			return modelId;
		},
		onSuccess: invalidate,
	});

	const createDeployment = useMutation({
		mutationFn: async ({
			modelId,
			...body
		}: DeploymentUpdate & { modelId: string; api_key: string }) => {
			const { data } = await axiosInstance.post<{
				deployment: ServedModelDeployment;
			}>(
				`/v1/served_models/${encodeURIComponent(modelId)}/deployments`,
				body,
			);
			return data.deployment;
		},
		onSuccess: invalidate,
	});

	const updateDeployment = useMutation({
		mutationFn: async ({
			modelId,
			deploymentId,
			...body
		}: DeploymentUpdate & { modelId: string; deploymentId: string }) => {
			const { data } = await axiosInstance.patch<{
				deployment: ServedModelDeployment;
			}>(
				`/v1/served_models/${encodeURIComponent(modelId)}/deployments/${encodeURIComponent(deploymentId)}`,
				body,
			);
			return data.deployment;
		},
		onSuccess: invalidate,
	});

	const removeDeployment = useMutation({
		mutationFn: async ({
			modelId,
			deploymentId,
		}: {
			modelId: string;
			deploymentId: string;
		}) => {
			await axiosInstance.delete(
				`/v1/served_models/${encodeURIComponent(modelId)}/deployments/${encodeURIComponent(deploymentId)}`,
			);
			return deploymentId;
		},
		onSuccess: invalidate,
	});

	return {
		models: list.data?.models ?? [],
		availableModels: available.data?.models ?? [],
		isLoading: list.isLoading,
		isLoadingAvailable: available.isLoading,
		error: list.error,
		upsert: upsert.mutateAsync,
		isUpserting: upsert.isPending,
		remove: remove.mutateAsync,
		isRemoving: remove.isPending,
		createDeployment: createDeployment.mutateAsync,
		isCreatingDeployment: createDeployment.isPending,
		updateDeployment: updateDeployment.mutateAsync,
		isUpdatingDeployment: updateDeployment.isPending,
		removeDeployment: removeDeployment.mutateAsync,
		isRemovingDeployment: removeDeployment.isPending,
	};
};
