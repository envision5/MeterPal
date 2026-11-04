import { AppEnv } from "@autumn/shared";
import { useState } from "react";
import { toast } from "sonner";
import { useOrg } from "@/hooks/common/useOrg";
import { useOrgPaypalQuery } from "@/hooks/queries/useOrgPaypalQuery";
import { useDevQuery } from "@/hooks/queries/useDevQuery";
import { DevService } from "@/services/DevService";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { getBackendErr } from "@/utils/genUtils";

/**
 * The three production-deploy actions, split from their markup so the dialog
 * and the onboarding page can each lay them out in their own grammar.
 */
export const useConnectPaypal = () => {
	const { paypalConfig } = useOrgPaypalQuery();
	const isConnected = paypalConfig?.live.connected ?? false;

	// PayPal connects through merchant credentials, so the action sends the
	// operator to the settings page where those are entered.
	const connect = () => {
		window.location.href = "/settings?tab=paypal";
	};

	return { isConnected, connect };
};

export const useCopyPlansToProd = () => {
	const sandboxAxios = useAxiosInstance({ env: AppEnv.Sandbox });
	const [isCopying, setIsCopying] = useState(false);
	const [isCopied, setIsCopied] = useState(false);

	const copyPlans = async () => {
		setIsCopying(true);
		try {
			await sandboxAxios.post("/products/copy_to_production");
			setIsCopied(true);
			toast.success("Successfully copied products to production");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to copy products"));
		} finally {
			setIsCopying(false);
		}
	};

	return { isCopied, isCopying, copyPlans };
};

/** Flips the org to deployed, which is what unlocks the production env in the
 * sidebar. A hard reload so every env-scoped query refetches against live. */
export const useGoToProduction = () => {
	const axiosInstance = useAxiosInstance();
	const { mutate } = useOrg();
	const [isDeploying, setIsDeploying] = useState(false);

	const goToProduction = async () => {
		setIsDeploying(true);
		try {
			await axiosInstance.patch("/v1/organization", { deployed: true });
			await mutate();
			window.location.href = "/products?tab=products";
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to deploy to production"));
			setIsDeploying(false);
		}
	};

	return { isDeploying, goToProduction };
};

export const useCreateProdApiKey = () => {
	const { refetch } = useDevQuery();
	const axiosInstance = useAxiosInstance({ env: AppEnv.Live });
	const [isCreating, setIsCreating] = useState(false);
	const [apiKey, setApiKey] = useState("");

	const createApiKey = async () => {
		setIsCreating(true);
		try {
			const { api_key } = await DevService.createAPIKey(axiosInstance, {
				name: "Production Secret Key",
			});
			setApiKey(api_key);
			refetch();
		} catch {
			toast.error("Failed to create API key");
		} finally {
			setIsCreating(false);
		}
	};

	return { apiKey, isCreating, createApiKey };
};
