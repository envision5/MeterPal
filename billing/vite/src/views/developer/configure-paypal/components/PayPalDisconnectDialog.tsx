import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@autumn/ui";

export const PayPalDisconnectDialog = ({
	open,
	onOpenChange,
	isLive,
	onConfirm,
	isLoading,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	isLive: boolean;
	onConfirm: () => void;
	isLoading: boolean;
}) => {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Disconnect PayPal</DialogTitle>
					<DialogDescription>
						MeterPal will stop using your {isLive ? "live" : "sandbox"} PayPal
						credentials for this organization. Existing subscriptions stay on
						PayPal, but no new ones can be created until you reconnect.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onConfirm} isLoading={isLoading}>
						Disconnect
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
