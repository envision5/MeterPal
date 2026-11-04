import { Button, IconButton } from "@autumn/ui";
import { Check } from "lucide-react";
import { SectionHeader } from "@/views/onboarding3/components/integration-step/SectionHeader";
import { useConnectPaypal } from "./useDeployActions";

export const Step1ConnectPaypal = () => {
	const { isConnected, connect } = useConnectPaypal();

	return (
		<div className="flex gap-3">
			<div className="flex items-center gap-2">
				<SectionHeader
					stepNumber={1}
					title="Connect your PayPal account"
					description="Add your PayPal production credentials to accept live payments"
					className="gap-0 flex-1"
				/>
			</div>

			<div className="pl-[32px] flex gap-2">
				{isConnected ? (
					<div className="flex items-center gap-2">
						<IconButton
							variant="secondary"
							disabled
							icon={<Check size={16} className="text-green-600" />}
							className="!opacity-100"
						>
							PayPal Connected
						</IconButton>
					</div>
				) : (
					<div>
						<Button variant="secondary" onClick={connect} className="w-36">
							Connect Live PayPal
						</Button>
					</div>
				)}
			</div>
		</div>
	);
};
