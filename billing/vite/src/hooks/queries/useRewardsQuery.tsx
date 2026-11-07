import type { Reward, RewardProgram } from "@autumn/shared";
import { useQuery } from "@tanstack/react-query";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";
import { useAxiosInstance } from "@/services/useAxiosInstance";

// The rewards/referral public API is unmounted server-side (see the
// [REWARDS DISABLED] notes on the api router). The dashboard keeps the hook
// for its consumers, but no request fires: querying /products/rewards would
// 404 on every page load.
const REWARDS_ENABLED = false;

export const useRewardsQuery = () => {
	const axiosInstance = useAxiosInstance();
	const buildKey = useQueryKeyFactory();

	const fetchRewards = async () => {
		const { data } = await axiosInstance.get("/products/rewards");
		return data;
	};

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: buildKey(["rewards"]),
		queryFn: fetchRewards,
		enabled: REWARDS_ENABLED,
	});

	return {
		rewards: (data?.rewards || []) as Reward[],
		rewardPrograms: (data?.rewardPrograms || []) as RewardProgram[],
		isLoading,
		error,
		refetch,
	};
};
