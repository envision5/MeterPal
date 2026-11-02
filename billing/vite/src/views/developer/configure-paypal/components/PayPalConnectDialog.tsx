import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	FormLabel,
	Input,
} from "@autumn/ui";
import { useState } from "react";

export const PayPalConnectDialog = ({
	open,
	onOpenChange,
	env,
	isLive,
	clientId,
	onClientIdChange,
	clientSecret,
	onClientSecretChange,
	webhookId,
	onWebhookIdChange,
	webhookUrlTemplate,
	onSave,
	isLoading,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	env: string;
	isLive: boolean;
	clientId: string;
	onClientIdChange: (value: string) => void;
	clientSecret: string;
	onClientSecretChange: (value: string) => void;
	webhookId: string;
	onWebhookIdChange: (value: string) => void;
	webhookUrlTemplate: string;
	onSave: () => void;
	isLoading: boolean;
}) => {
	const [showSecret, setShowSecret] = useState(false);

	const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						Connect your {isLive ? "live" : "sandbox"} PayPal account
					</DialogTitle>
					<DialogDescription>
						Create a REST app in the PayPal Developer Dashboard, then paste
						its client ID and secret here. MeterPal uses them to create
						subscriptions and collect payment on your behalf.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div>
						<FormLabel>
							<span className="text-muted-foreground">Client ID</span>
						</FormLabel>
						<Input
							value={clientId}
							onChange={(e) => onClientIdChange(e.target.value)}
							placeholder="Aea1..."
							autoComplete="off"
						/>
					</div>

					<div>
						<FormLabel>
							<span className="text-muted-foreground">Client secret</span>
						</FormLabel>
						<div className="flex gap-2">
							<Input
								value={clientSecret}
								onChange={(e) => onClientSecretChange(e.target.value)}
								placeholder="Your client secret"
								type={showSecret ? "text" : "password"}
								autoComplete="off"
							/>
							<Button
								variant="secondary"
								onClick={() => setShowSecret((v) => !v)}
								type="button"
							>
								{showSecret ? "Hide" : "Show"}
							</Button>
						</div>
					</div>

					<div>
						<FormLabel>
							<span className="text-muted-foreground">
								Webhook ID (optional)
							</span>
						</FormLabel>
						<Input
							value={webhookId}
							onChange={(e) => onWebhookIdChange(e.target.value)}
							placeholder="WH-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
							autoComplete="off"
						/>
						<p className="mt-1.5 text-subtle text-xs leading-4">
							Add a webhook in your PayPal app pointing at{" "}
							<code className="font-mono text-foreground text-tiny">
								{webhookUrlTemplate}
							</code>{" "}
							and paste the webhook ID here. Without it, MeterPal cannot
							confirm that a payment completed.
						</p>
					</div>

					<div className="flex gap-2 justify-end">
						<Button variant="secondary" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button
							onClick={onSave}
							isLoading={isLoading}
							disabled={!canSave}
						>
							Connect PayPal
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
