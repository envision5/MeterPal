import type { AgentConfig } from "@autumn/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";
import { useAxiosInstance } from "@/services/useAxiosInstance";

/**
 * The merchant's agent configuration — the sales agent's pricing mandate and
 * the buyer agent's default terms.
 *
 * The server returns the *effective* config (defaults filled in when nothing
 * has been saved), so the form never has to model "unset".
 */
export const useAgentConfigQuery = () => {
	const axiosInstance = useAxiosInstance();
	const buildKey = useQueryKeyFactory();
	const queryClient = useQueryClient();
	const queryKey = buildKey(["agent-config"]);

	const { data, isLoading, error } = useQuery<AgentConfig>({
		queryKey,
		queryFn: async () => {
			const { data } = await axiosInstance.get<AgentConfig>(
				"/organization/agent-config",
			);
			return data;
		},
	});

	const update = useMutation({
		mutationFn: async (config: Partial<AgentConfig>) => {
			const { data } = await axiosInstance.patch<AgentConfig>(
				"/organization/agent-config",
				config,
			);
			return data;
		},
		onSuccess: (next) => {
			queryClient.setQueryData(queryKey, next);
		},
	});

	return {
		config: data,
		isLoading,
		error,
		update: update.mutateAsync,
		isUpdating: update.isPending,
	};
};
