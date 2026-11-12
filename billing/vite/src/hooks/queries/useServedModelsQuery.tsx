import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useEnv } from "@/utils/envUtils";

/** Stable empty lists, so a caller does not re-render on every render. */
const EMPTY_SERVED_MODELS: ServedModel[] = [];
const EMPTY_AVAILABLE_MODELS: AvailableModel[] = [];

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
	/** Input modalities beyond text: "image", "audio", "pdf", "video".
	 *  Null = not configured, [] = text only. */
	modalities: string[] | null;
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
	/**
	 * The markup that will actually be charged, in percent.
	 *
	 * The server resolves this the way the request path resolves it, so the
	 * price the dashboard shows is the price on the invoice.
	 */
	effective_markup_pct: number;
	/** Where the charged markup comes from. */
	effective_markup_source: "model" | "plan" | "none";
	/**
	 * The markup the plan applies on its own -- what this model is charged
	 * when the merchant's own markup is unset.
	 */
	plan_markup_pct: number;
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
	/** The catalog provider's display name, e.g. "302.AI". */
	provider_name: string | null;
	/**
	 * What an instance of this model is called on the gateway.
	 *
	 * The catalog id and the gateway id are different vocabularies —
	 * `302ai/claude-fable-5` is served as `openai/claude-fable-5` — so this
	 * is what the instance form starts from.
	 */
	provider_model: string | null;
	/** The provider's base URL; null when the SDK already knows it. */
	api_base: string | null;
	/** Input modalities beyond text, pre-filled from the catalog. Null when
	 *  the catalog does not say, which is not the same as "text only". */
	modalities: string[] | null;
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

/** The markup the org's plan applies to one model, on its own. */
export interface ModelPlanMarkup {
	model_id: string;
	plan_markup_pct: number;
	plan_markup_source: "model" | "provider" | "default" | "none";
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
	/** Absent keeps the stored modalities; [] declares text only. */
	modalities?: string[] | null;
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

	/**
	 * The markup the plan applies to a model, on its own.
	 *
	 * Fetched rather than computed: a model the provider feed does not know,
	 * or a custom model the credit system has no cost for, is charged at no
	 * markup at all, and only the server knows which case a model is.
	 *
	 * Stable identity on purpose -- the editor fetches this as the model id
	 * changes, and a new function identity every render would refetch
	 * forever.
	 */
	const fetchPlanMarkup = useCallback(
		async (modelId: string): Promise<ModelPlanMarkup> => {
			const { data } = await axiosInstance.get<ModelPlanMarkup>(
				"/v1/served_models/markup",
				{ params: { model_id: modelId } },
			);
			return data;
		},
		[axiosInstance],
	);

	return {
		models: list.data?.models ?? EMPTY_SERVED_MODELS,
		availableModels: available.data?.models ?? EMPTY_AVAILABLE_MODELS,
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
		fetchPlanMarkup,
	};
};
