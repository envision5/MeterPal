import { AppEnv } from "@autumn/shared";
import { Button, Skeleton } from "@autumn/ui";
import { PaypalLogoIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { useOrgPaypalQuery } from "@/hooks/queries/useOrgPaypalQuery";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useEnv } from "@/utils/envUtils";
import { getBackendErr } from "@/utils/genUtils";
import {
	SETTINGS_LIST_CLASS,
	SettingsGroup,
} from "@/views/settings/components/SettingsGroup";
import { PayPalConnectDialog } from "./components/PayPalConnectDialog";
import { PayPalDisconnectDialog } from "./components/PayPalDisconnectDialog";

export const ConfigurePayPal = () => {
	const axiosInstance = useAxiosInstance();
	const env = useEnv();
	const { paypalConfig, currentEnvStatus, isLoading, refetch } =
		useOrgPaypalQuery();

	const [showConnectDialog, setShowConnectDialog] = useState(false);
	const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isDisconnecting, setIsDisconnecting] = useState(false);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [webhookId, setWebhookId] = useState("");

	const isLive = env === AppEnv.Live;
	const connected = currentEnvStatus?.connected ?? false;
	const sharedAccount = currentEnvStatus?.shared_account ?? false;
	const ownAccount = connected && !sharedAccount;

	const handleConnect = async () => {
		setIsSaving(true);
		try {
			await axiosInstance.post("/v1/organization/paypal", {
				client_id: clientId.trim(),
				client_secret: clientSecret.trim(),
				...(webhookId.trim() ? { webhook_id: webhookId.trim() } : {}),
			});
			await refetch();
			setShowConnectDialog(false);
			setClientId("");
			setClientSecret("");
			setWebhookId("");
			toast.success("PayPal connected");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to connect PayPal"));
		} finally {
			setIsSaving(false);
		}
	};

	const handleDisconnect = async () => {
		setIsDisconnecting(true);
		try {
			await axiosInstance.delete("/v1/organization/paypal");
			await refetch();
			setShowDisconnectDialog(false);
			toast.success("PayPal disconnected");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to disconnect PayPal"));
		} finally {
			setIsDisconnecting(false);
		}
	};

	const accountLabel = ownAccount
		? (currentEnvStatus?.account_email ??
			currentEnvStatus?.client_id ??
			"Connected")
		: sharedAccount
			? "Using MeterPal's shared PayPal account"
			: "Not connected";

	const webhookRegistered = ownAccount && !!currentEnvStatus?.webhook_id;
	const otherEnvStatus = isLive ? paypalConfig?.sandbox : paypalConfig?.live;

	return (
		<div className="flex flex-col gap-10">
			<SettingsGroup
				title="Connection"
				description={
					ownAccount
						? "MeterPal creates PayPal subscriptions and collects payment through this account."
						: sharedAccount
							? "This organization is billing through MeterPal's shared PayPal account. Connect your own to receive the money directly."
							: "Connect your PayPal account so MeterPal can create subscriptions and collect payment for you."
				}
			>
				{isLoading ? (
					<Skeleton className="h-[72px] w-full rounded-lg" />
				) : (
					<div className={SETTINGS_LIST_CLASS}>
						<div className="flex items-center gap-4 px-4 py-3.5">
							<PaypalLogoIcon size={22} className="shrink-0 text-[#003087]" />
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="font-medium text-foreground text-sm">
									PayPal
								</span>
								<span className="truncate text-tertiary-foreground text-xs">
									{accountLabel}
								</span>
							</div>
							<span className="flex w-[84px] shrink-0">
								{connected && (
									<span className="flex items-center gap-1.5 font-medium text-emerald-500 text-xs">
										<span className="size-1.5 rounded-full bg-emerald-500" />
										Connected
									</span>
								)}
							</span>
							<div className="flex w-24 shrink-0">
								{ownAccount ? (
									<Button
										variant="secondary"
										className="w-full"
										onClick={() => setShowDisconnectDialog(true)}
									>
										Disconnect
									</Button>
								) : (
									<Button
										variant="primary"
										className="w-full"
										onClick={() => setShowConnectDialog(true)}
									>
										Connect
									</Button>
								)}
							</div>
						</div>
					</div>
				)}
			</SettingsGroup>

			<SettingsGroup
				title="Webhook"
				description="PayPal signs every event it sends. Registering the webhook lets MeterPal confirm that a payment completed instead of assuming it."
			>
				<div className={SETTINGS_LIST_CLASS}>
					<div className="flex flex-col gap-1.5 px-4 py-3.5">
						<span className="font-medium text-foreground text-sm">
							Webhook URL
						</span>
						<code className="break-all font-mono text-subtle text-xs">
							{paypalConfig?.webhook_url_template ?? "—"}
						</code>
						<span className="mt-1 text-tertiary-foreground text-xs">
							{webhookRegistered
								? `Registered · ${currentEnvStatus?.webhook_id}`
								: "Not registered. Paste the webhook ID when you connect PayPal so subscription and payment events reach MeterPal."}
						</span>
					</div>
				</div>
			</SettingsGroup>

			{otherEnvStatus && (
				<SettingsGroup
					title={isLive ? "Sandbox" : "Live"}
					description="The other environment's PayPal connection is kept separately, so setting up live does not disturb your sandbox work."
				>
					<div className={SETTINGS_LIST_CLASS}>
						<div className="flex items-center gap-4 px-4 py-3.5">
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="font-medium text-foreground text-sm">
									{isLive ? "Sandbox PayPal" : "Live PayPal"}
								</span>
								<span className="truncate text-tertiary-foreground text-xs">
									{otherEnvStatus.connected
										? (otherEnvStatus.shared_account
											? "Using MeterPal's shared PayPal account"
											: (otherEnvStatus.account_email ??
												otherEnvStatus.client_id))
										: "Not connected"}
								</span>
							</div>
							<span className="flex w-[84px] shrink-0">
								{otherEnvStatus.connected && (
									<span className="flex items-center gap-1.5 font-medium text-emerald-500 text-xs">
										<span className="size-1.5 rounded-full bg-emerald-500" />
										Connected
									</span>
								)}
							</span>
						</div>
					</div>
				</SettingsGroup>
			)}

			<PayPalConnectDialog
				open={showConnectDialog}
				onOpenChange={setShowConnectDialog}
				env={env}
				isLive={isLive}
				clientId={clientId}
				onClientIdChange={setClientId}
				clientSecret={clientSecret}
				onClientSecretChange={setClientSecret}
				webhookId={webhookId}
				onWebhookIdChange={setWebhookId}
				webhookUrlTemplate={
					paypalConfig?.webhook_url_template ?? "http://localhost:8080"
				}
				onSave={handleConnect}
				isLoading={isSaving}
			/>

			<PayPalDisconnectDialog
				open={showDisconnectDialog}
				onOpenChange={setShowDisconnectDialog}
				isLive={isLive}
				onConfirm={handleDisconnect}
				isLoading={isDisconnecting}
			/>
		</div>
	);
};
