import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useEnv } from "@/utils/envUtils";

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
	};
};
