import { AppEnv } from "@autumn/shared";
import { useQuery } from "@tanstack/react-query";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useEnv } from "@/utils/envUtils";
import { useOrg } from "../common/useOrg";

export interface PaypalEnvStatus {
	/** True when this org can bill through PayPal in this env. */
	connected: boolean;
	/** True when the connection comes from the platform's shared account. */
	shared_account: boolean;
	/** Masked client id. */
	client_id: string | null;
	/** The PayPal account the connection acts on behalf of. */
	account_email: string | null;
	/** The webhook id the org registered with PayPal. */
	webhook_id: string | null;
	/** Epoch ms when the org connected. */
	connected_at: number | null;
}

export interface PaypalConfigResponse {
	env: AppEnv;
	sandbox: PaypalEnvStatus;
	live: PaypalEnvStatus;
	/** Where the merchant points their PayPal webhook. */
	webhook_url_template: string;
}

/** Fetches the org's PayPal connection status for both environments. */
export const useOrgPaypalQuery = () => {
	const axiosInstance = useAxiosInstance();
	const buildKey = useQueryKeyFactory();
	const { org } = useOrg();
	const env = useEnv();

	const fetcher = async () => {
		const { data } = await axiosInstance.get<PaypalConfigResponse>(
			"/v1/organization/paypal",
		);
		return data;
	};

	const { data, isLoading, error, refetch } = useQuery<PaypalConfigResponse>({
		queryKey: buildKey(["org", org?.id, "paypal", env]),
		queryFn: fetcher,
		retry: false,
		enabled: !!org?.id,
	});

	return {
		paypalConfig: data ?? null,
		/** The status for the environment the dashboard is currently on. */
		currentEnvStatus: data
			? env === AppEnv.Live
				? data.live
				: data.sandbox
			: null,
		isLoading,
		error,
		refetch,
	};
};
