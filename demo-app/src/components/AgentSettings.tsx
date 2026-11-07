// demo-app/src/components/AgentSettings.tsx
//
// Where the customer hands their AI a mandate: when it may spend, how it
// handles 402s, and the budget it must respect.  The mandate lives in the
// customer's metadata on the billing server; the policy that enforces it is
// demo-app/agent/mandate.ts.

import { useEffect, useRef, useState } from "react";

type Mandate = {
	enabled: boolean;
	max_per_purchase: number;
	monthly_budget: number;
	auto_approve_below: number;
};

type Insights = {
	balance: number | null;
	insights: {
		monthSpend: number;
		last24hSpend: number;
		burnRatePerDay: number;
		daysToEmpty: number | null;
		anomaly: { flagged: boolean; reason: string | null };
	} | null;
};

const DEFAULT_MANDATE: Mandate = {
	enabled: false,
	max_per_purchase: 10,
	monthly_budget: 100,
	auto_approve_below: 15,
};

export default function AgentSettings() {
	const [mandate, setMandate] = useState<Mandate>(DEFAULT_MANDATE);
	const [loaded, setLoaded] = useState(false);
	// The panel polls; once the initial mandate is loaded, polling must never
	// clobber what the user is typing — only the spend readouts refresh.
	const loadedRef = useRef(false);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<string | null>(null);
	const [spend, setSpend] = useState<Insights | null>(null);

	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const res = await fetch("/api/agent-settings");
				const data = await res.json();
				if (!alive) return;
				if (data?.mandate && !loadedRef.current) {
					setMandate(data.mandate);
					loadedRef.current = true;
				}
				setSpend({ balance: data?.balance ?? null, insights: data?.insights?.insights ?? null });
				setLoaded(true);
			} catch {
				/* panel stays on defaults */
			}
		};
		load();
		const timer = setInterval(load, 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, []);

	async function save() {
		setSaving(true);
		try {
			const res = await fetch("/api/agent-settings", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-meterpal-customer": customerId,
				},
				body: JSON.stringify({ mandate }),
			});
			if (res.ok) setSavedAt(new Date().toLocaleTimeString());
		} finally {
			setSaving(false);
		}
	}

	const monthSpend = spend?.insights?.monthSpend;
	const budgetPct =
		monthSpend !== undefined && mandate.monthly_budget > 0
			? Math.min(100, Math.round((monthSpend / mandate.monthly_budget) * 100))
			: null;
	const daysToEmpty = spend?.insights?.daysToEmpty;

	return (
		<div data-testid="agent-settings">
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={mandate.enabled}
					onChange={(e) => setMandate({ ...mandate, enabled: e.target.checked })}
					data-testid="agent-mandate-enabled"
				/>
				<span className="font-medium">Let my AI manage my credits</span>
			</label>
			<p className="mt-1 text-xs text-muted-foreground">
				On a 402, your agent picks a pack, respects the budget, and PayPal
				still asks you to approve every payment.
			</p>

			{loaded && (
				<div className="mt-3 space-y-2 text-sm">
					<label className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground">Auto-approve up to ($)</span>
						<input
							type="number"
							min={0}
							step={1}
							value={mandate.auto_approve_below}
							onChange={(e) =>
								setMandate({ ...mandate, auto_approve_below: Number(e.target.value) })
							}
							className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right"
							data-testid="agent-mandate-auto-approve"
						/>
					</label>
					<label className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground">Max per purchase ($)</span>
						<input
							type="number"
							min={0}
							step={1}
							value={mandate.max_per_purchase}
							onChange={(e) =>
								setMandate({ ...mandate, max_per_purchase: Number(e.target.value) })
							}
							className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right"
							data-testid="agent-mandate-max-purchase"
						/>
					</label>
					<label className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground">Monthly budget ($)</span>
						<input
							type="number"
							min={0}
							step={1}
							value={mandate.monthly_budget}
							onChange={(e) =>
								setMandate({ ...mandate, monthly_budget: Number(e.target.value) })
							}
							className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right"
							data-testid="agent-mandate-budget"
						/>
					</label>

					{budgetPct !== null && (
						<div className="pt-1">
							<div className="flex justify-between text-xs text-muted-foreground">
								<span data-testid="month-spend">
									${(monthSpend ?? 0).toFixed(2)} of $
									{mandate.monthly_budget.toFixed(2)} this month
								</span>
								<span>{budgetPct}%</span>
							</div>
							<div className="mt-1 h-1.5 rounded-full bg-muted">
								<div
									className={[
										"h-1.5 rounded-full",
										budgetPct > 90 ? "bg-red-500" : budgetPct > 60 ? "bg-amber-500" : "bg-emerald-500",
									].join(" ")}
									style={{ width: `${budgetPct}%` }}
								/>
							</div>
						</div>
					)}

					{daysToEmpty !== null && daysToEmpty !== undefined && (
						<p className="text-xs text-muted-foreground" data-testid="days-to-empty">
							Projected runway: {daysToEmpty.toFixed(1)} days at the current
							burn rate.
						</p>
					)}

					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
						data-testid="agent-mandate-save"
					>
						{saving ? "Saving…" : "Save mandate"}
					</button>
					{savedAt && (
						<p className="text-xs text-emerald-600" data-testid="mandate-saved">
							Saved at {savedAt}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
