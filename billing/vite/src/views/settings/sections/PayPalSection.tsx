import { ConfigurePayPal } from "@/views/developer/configure-paypal/ConfigurePayPal";
import { EnvironmentBadge } from "../components/EnvironmentBadge";
import { SettingsSection } from "../SettingsSection";

export const PayPalSection = () => {
	return (
		<SettingsSection
			title="PayPal"
			description="How MeterPal creates PayPal subscriptions and collects payment for this organization."
			actions={<EnvironmentBadge />}
		>
			<ConfigurePayPal />
		</SettingsSection>
	);
};
