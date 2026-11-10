// demo-app/src/components/SpendAlerts.tsx
//
// Budget tracking and unusual-spend flags for the customer, computed from the
// same ledger math the agents use (billing server usageInsights).  Renders
// nothing while nothing is wrong.

import { IconAlertTriangle, IconClock } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { authHeaders } from "../customerIdentity";

type Alert = { kind: "anomaly" | "runway"; text: string } | null;

export default function SpendAlerts({ customerId }: { customerId: string }) {
	const [alert, setAlert] = useState<Alert>(null);

	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const res = await fetch("/api/agent-settings", {
					headers: authHeaders(customerId),
				});
				const data = await res.json();
				if (!alive) return;
				const insights = data?.insights?.insights;
				if (insights?.anomaly?.flagged) {
					setAlert({ kind: "anomaly", text: insights.anomaly.reason });
					return;
				}
				if (
					insights?.daysToEmpty !== null &&
					insights?.daysToEmpty !== undefined &&
					insights.daysToEmpty < 3
				) {
					setAlert({
						kind: "runway",
						text: `At the current burn rate your balance is empty in ${insights.daysToEmpty.toFixed(1)} days.`,
					});
					return;
				}
				setAlert(null);
			} catch {
				/* no alerts on failure */
			}
		};
		load();
		const timer = setInterval(load, 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, []);

	if (!alert) return null;

	return (
		<div
			role="alert"
			data-testid="spend-alert"
			className={[
				"rounded-md border px-4 py-3 text-sm",
				alert.kind === "anomaly"
					? "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-100"
					: "border-sky-500/50 bg-sky-500/10 text-sky-900 dark:text-sky-100",
			].join(" ")}
		>
			<strong className="mr-1">
				{alert.kind === "anomaly" ? "Unusual spend —" : "Runway:"}
			</strong>
			{alert.text}
		</div>
	);
}
