import type { ChatConfig } from "@autumn/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";
import { useAxiosInstance } from "@/services/useAxiosInstance";

/**
 * The merchant's chat settings — currently whether the app streams its
 * responses.
 *
 * The server returns the *effective* config (the shipped default filled in
 * when nothing has been saved), so the form never has to model "unset".
 */
export const useChatConfigQuery = () => {
	const axiosInstance = useAxiosInstance();
	const buildKey = useQueryKeyFactory();
	const queryClient = useQueryClient();
	const queryKey = buildKey(["chat-config"]);

	const { data, isLoading, error } = useQuery<ChatConfig>({
		queryKey,
		queryFn: async () => {
			const { data } = await axiosInstance.get<ChatConfig>(
				"/organization/chat-config",
			);
			return data;
		},
	});

	const update = useMutation({
		mutationFn: async (config: Partial<ChatConfig>) => {
			const { data } = await axiosInstance.patch<ChatConfig>(
				"/organization/chat-config",
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
