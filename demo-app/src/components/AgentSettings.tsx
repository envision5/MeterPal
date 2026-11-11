// demo-app/src/components/AgentSettings.tsx
//
// Where the customer hands their AI a mandate: when it may spend, how it
// handles 402s, and the budget it must respect.  The mandate lives in the
// customer's metadata on the billing server; the policy that enforces it is
// demo-app/agent/mandate.ts.

import {
	IconCheck,
	IconClock,
	IconCoins,
	IconRobot,
	IconShieldCheck,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "../customerIdentity";

type Mandate = {
	enabled: boolean;
	max_per_purchase: number;
	monthly_budget: number;
	auto_approve_below: number;
};

/**
 * Where the mandate on screen came from.
 *
 * "customer"          this customer's own terms (saved here)
 * "merchant-default"  the merchant's standing terms, which the agent acts on
 *                     until this customer saves their own
 * "none"              nothing governs the agent, so it does not act
 */
type MandateSource = "customer" | "merchant-default" | "none";

type Insights = {
	balance: number | null;
	insights: {
		monthSpend: number;
		last24hSpend: number;
		burnRatePerDay: number;
		daysToEmpty: number | null;
		/** Whether the runway is a rate (trailing week) or a single day. */
		runwayBasis?: "trailing-week" | "today" | "none";
		anomaly: { flagged: boolean; reason: string | null };
	} | null;
};

const DEFAULT_MANDATE: Mandate = {
	enabled: false,
	max_per_purchase: 10,
	monthly_budget: 100,
	auto_approve_below: 15,
};

function MandateField({
	label,
	testid,
	value,
	onChange,
}: {
	label: string;
	testid: string;
	value: number;
	onChange: (v: number) => void;
}) {
	return (
		<label className="flex items-center justify-between gap-2">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1">
				<span className="text-xs text-muted-foreground">$</span>
				<input
					type="number"
					min={0}
					step={1}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					className="w-16 bg-transparent text-right text-sm outline-none"
					data-testid={testid}
				/>
			</span>
		</label>
	);
}

export default function AgentSettings({ customerId }: { customerId: string }) {
	const [mandate, setMandate] = useState<Mandate>(DEFAULT_MANDATE);
	const [source, setSource] = useState<MandateSource>("none");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<string | null>(null);
	const [spend, setSpend] = useState<Insights | null>(null);
	// The panel polls; once the initial mandate is loaded, polling must never
	// clobber what the user is typing — only the spend readouts refresh.
	const loadedRef = useRef(false);

	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const res = await fetch("/api/agent-settings", {
					headers: authHeaders(customerId),
				});
				const data = await res.json();
				if (!alive) return;
				// The mandate the agent is actually acting on, including the
				// merchant's standing terms this customer has not overridden.
				// Showing the per-customer key alone said "Agent off" while the
				// agent was buying under the default.
				if (data?.mandate && !loadedRef.current) {
					setMandate(data.mandate);
					setSource((data?.mandate_source as MandateSource) ?? "customer");
					loadedRef.current = true;
				} else if (!loadedRef.current && data && !data.mandate) {
					setSource("none");
					loadedRef.current = true;
				}
				setSpend({
					balance: data?.balance ?? null,
					insights: data?.insights?.insights ?? null,
				});
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
	}, [customerId]);

	async function save() {
		setSaving(true);
		try {
			const res = await fetch("/api/agent-settings", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...authHeaders(customerId),
				},
				body: JSON.stringify({ mandate }),
			});
			if (res.ok) {
				setSavedAt(new Date().toLocaleTimeString());
				// Saving writes this customer's own terms, so from here on the
				// merchant default no longer governs them.
				setSource("customer");
			}
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
	const runwayBasis = spend?.insights?.runwayBasis;

	return (
		<div data-testid="agent-settings">
			<p className="mb-3 text-xs text-muted-foreground">
				On a 402, your agent sizes a pack from your real usage and opens PayPal
				approval automatically for purchases inside your auto-approve line.
				Raise max per purchase and auto-approve up to let it buy bigger packs.
			</p>

			<button
				type="button"
				role="switch"
				aria-checked={mandate.enabled}
				onClick={() => setMandate({ ...mandate, enabled: !mandate.enabled })}
				className={[
					"flex w-full items-center gap-2.5 rounded-xl border p-3 text-left transition",
					mandate.enabled
						? "border-violet-500/50 bg-violet-500/10"
						: "border-border bg-background hover:bg-muted/60",
				].join(" ")}
				data-testid="agent-mandate-enabled"
			>
				<span
					className={[
						"flex size-8 shrink-0 items-center justify-center rounded-lg",
						mandate.enabled
							? "bg-violet-500/20 text-violet-300"
							: "bg-muted text-muted-foreground",
					].join(" ")}
				>
					<IconRobot size={17} />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium">
						Let my AI manage my credits
					</span>
					<span
						className="block text-[11px] text-muted-foreground"
						data-testid="agent-mandate-status"
					>
						{mandate.enabled
							? source === "merchant-default"
								? "Agent active — on the merchant's default terms below"
								: "Agent active on the next 402"
							: "Agent off — you handle top-ups"}
					</span>
				</span>
				<span
					className={[
						"relative h-5 w-9 shrink-0 rounded-full transition",
						mandate.enabled ? "bg-violet-500" : "bg-muted-foreground/30",
					].join(" ")}
				>
					<span
						className={[
							"absolute top-0.5 size-4 rounded-full bg-white transition-all",
							mandate.enabled ? "left-[18px]" : "left-0.5",
						].join(" ")}
					/>
				</span>
			</button>

			{loaded && source === "merchant-default" && (
				<p
					className="mt-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground"
					data-testid="agent-mandate-inherited"
				>
					These are the merchant's standing terms, not this customer's own.
					The agent already acts on them; <strong>Save mandate</strong> writes
					them for this customer and overrides the default.
				</p>
			)}

			{loaded && (
				<div className="mt-3 space-y-2">
					<MandateField
						label="Auto-approve up to"
						testid="agent-mandate-auto-approve"
						value={mandate.auto_approve_below}
						onChange={(v) => setMandate({ ...mandate, auto_approve_below: v })}
					/>
					<MandateField
						label="Max per purchase"
						testid="agent-mandate-max-purchase"
						value={mandate.max_per_purchase}
						onChange={(v) => setMandate({ ...mandate, max_per_purchase: v })}
					/>
					<MandateField
						label="Monthly budget"
						testid="agent-mandate-budget"
						value={mandate.monthly_budget}
						onChange={(v) => setMandate({ ...mandate, monthly_budget: v })}
					/>

					{budgetPct !== null && (
						<div className="pt-1">
							<div className="flex items-center justify-between text-xs text-muted-foreground">
								<span
									className="flex items-center gap-1"
									data-testid="month-spend"
								>
									<IconCoins size={12} />
									${(monthSpend ?? 0).toFixed(2)} of $
									{mandate.monthly_budget.toFixed(2)} this month
								</span>
								<span>{budgetPct}%</span>
							</div>
							<div className="mt-1 h-1.5 rounded-full bg-muted">
								<div
									className={[
										"h-1.5 rounded-full transition-all",
										budgetPct > 90
											? "bg-rose-500"
											: budgetPct > 60
												? "bg-amber-500"
												: "bg-emerald-500",
									].join(" ")}
									style={{ width: `${budgetPct}%` }}
								/>
							</div>
						</div>
					)}

					{daysToEmpty !== null && daysToEmpty !== undefined && (
						<p
							className="flex items-center gap-1 text-xs text-muted-foreground"
							data-testid="days-to-empty"
						>
							<IconClock size={12} />
							Projected runway: {daysToEmpty.toFixed(1)} days
							{/* A projection off a single day is a sample, not a rate.
							    Saying "current burn rate" there dressed one day of
							    spend up as a trend — 3 credits against $0.03 spent
							    read as a confident 94 days. */}
							{runwayBasis === "today"
								? " — extrapolated from today's spend only, no trailing week yet."
								: " at the current burn rate."}
						</p>
					)}

					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
						data-testid="agent-mandate-save"
					>
						<IconShieldCheck size={15} />
						{saving ? "Saving…" : "Save mandate"}
					</button>
					{savedAt && (
						<p
							className="flex items-center gap-1 text-xs text-emerald-400"
							data-testid="mandate-saved"
						>
							<IconCheck size={12} />
							Saved at {savedAt}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
