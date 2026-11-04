// billing/vite/src/views/portal/PortalView.tsx
//
// Self-hosted billing portal for PayPal customers — the PayPal branch of
// "Open billing portal" lands here (PayPal has no hosted portal equivalent to
// Stripe's). Public page: the signed token in the URL is the credential; the
// server endpoints under /portal/:token verify it (portalRouter.ts).

import axios from "axios";
import * as React from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface PortalPlan {
	name: string | null;
	amount: number | null;
	interval: string | null;
}

interface PortalData {
	org_name: string | null;
	customer: { id: string; name: string | null; email: string | null };
	subscription: {
		paypal_subscription_id: string | null;
		status: string | null;
		paypal_status: string | null;
		plan: PortalPlan | null;
	};
	payment_method: { type: "paypal"; email: string | null };
	history: Array<{
		date: string;
		description: string | null;
		amount_usd: number | null;
		kind: string;
	}>;
}

const backendUrl = (import.meta.env.VITE_BACKEND_URL ?? "").replace(/\/+$/, "");

const formatUsd = (amount: number | null) => {
	if (amount === null || amount === undefined) return "—";
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
	}).format(amount);
};

const intervalLabel: Record<string, string> = {
	month: "/mo",
	year: "/yr",
	week: "/wk",
	day: "/day",
	quarter: "/quarter",
	semi_annual: "/6 months",
};

const statusStyles: Record<string, string> = {
	active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30",
	pending: "bg-amber-500/10 text-amber-500 border-amber-500/30",
	suspended: "bg-amber-500/10 text-amber-500 border-amber-500/30",
	failed: "bg-red-500/10 text-red-500 border-red-500/30",
	cancelled: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
};

function StatusBadge({ status }: { status: string | null }) {
	const normalized = (status ?? "unknown").toLowerCase();
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
				statusStyles[normalized] ??
					"bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
			)}
		>
			{normalized}
		</span>
	);
}

function PortalCard({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="rounded-xl border border-zinc-800 bg-card p-6">
			<h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
			<div className="mt-4">{children}</div>
		</section>
	);
}

export const PortalView = () => {
	const [searchParams] = useSearchParams();
	const token = searchParams.get("token");

	const [data, setData] = React.useState<PortalData | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [confirmingCancel, setConfirmingCancel] = React.useState(false);
	const [cancelling, setCancelling] = React.useState(false);

	React.useEffect(() => {
		if (!token) {
			setError("This billing portal link is missing its access token.");
			return;
		}

		axios
			.get<PortalData>(`${backendUrl}/portal/${encodeURIComponent(token)}`)
			.then((response) => setData(response.data))
			.catch((err) => {
				if (err.response?.status === 401) {
					setError(
						"This billing portal link is invalid or has expired. Open it again from the app's billing settings.",
					);
				} else {
					setError("Failed to load your billing portal. Please try again.");
				}
			});
	}, [token]);

	const handleCancel = async () => {
		if (!token) return;
		setCancelling(true);
		try {
			await axios.post(
				`${backendUrl}/portal/cancel/${encodeURIComponent(token)}`,
			);
			setData((prev) =>
				prev
					? {
							...prev,
							subscription: { ...prev.subscription, status: "cancelled" },
						}
					: prev,
			);
			toast.success("Subscription cancelled");
		} catch {
			toast.error("Failed to cancel subscription");
		} finally {
			setCancelling(false);
			setConfirmingCancel(false);
		}
	};

	if (error) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-background p-6">
				<div className="max-w-md text-center">
					<h1 className="text-lg font-semibold text-zinc-100">
						Billing portal unavailable
					</h1>
					<p className="mt-2 text-sm text-muted-foreground">{error}</p>
				</div>
			</div>
		);
	}

	if (!data) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-background">
				<p className="text-sm text-muted-foreground">Loading billing portal…</p>
			</div>
		);
	}

	const { subscription, payment_method, history } = data;
	const effectiveStatus = subscription.status ?? subscription.paypal_status;
	const cancellable =
		!!subscription.paypal_subscription_id &&
		!["cancelled"].includes((effectiveStatus ?? "").toLowerCase());

	return (
		<div className="min-h-screen bg-background">
			<div className="mx-auto max-w-2xl px-6 py-12">
				<header className="mb-8">
					<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
						{data.org_name ?? "Billing"}
					</p>
					<h1 className="mt-1 text-2xl font-semibold text-zinc-100">
						Billing Portal
					</h1>
					{data.customer.name && (
						<p className="mt-1 text-sm text-muted-foreground">
							{data.customer.name}
							{data.customer.email ? ` · ${data.customer.email}` : ""}
						</p>
					)}
				</header>

				<div className="flex flex-col gap-5">
					<PortalCard title="Subscription">
						<div className="flex items-start justify-between gap-4">
							<div>
								<div className="flex items-center gap-3">
									<p className="text-base font-medium text-zinc-100">
										{subscription.plan?.name ?? "No active plan"}
									</p>
									{effectiveStatus && <StatusBadge status={effectiveStatus} />}
								</div>
								{subscription.plan?.amount !== null &&
									subscription.plan?.amount !== undefined && (
										<p className="mt-1 text-sm text-muted-foreground">
											{formatUsd(subscription.plan.amount)}
											{subscription.plan.interval
												? intervalLabel[subscription.plan.interval] ?? ""
												: ""}
										</p>
									)}
							</div>

							{cancellable &&
								(confirmingCancel ? (
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={handleCancel}
											disabled={cancelling}
											className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-60"
										>
											{cancelling ? "Cancelling…" : "Confirm cancellation"}
										</button>
										<button
											type="button"
											onClick={() => setConfirmingCancel(false)}
											className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
										>
											Keep plan
										</button>
									</div>
								) : (
									<button
										type="button"
										onClick={() => setConfirmingCancel(true)}
										className="rounded-lg border border-red-600/40 bg-red-600/10 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-600/20"
									>
										Cancel plan
									</button>
								))}
						</div>
					</PortalCard>

					<PortalCard title="Payment method">
						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="text-base font-medium text-zinc-100">PayPal</p>
								{payment_method.email && (
									<p className="mt-1 text-sm text-muted-foreground">
										{payment_method.email}
									</p>
								)}
							</div>
							<a
								href="https://www.paypal.com/myaccount/"
								target="_blank"
								rel="noreferrer"
								className="text-sm font-medium text-emerald-500 hover:underline"
							>
								Manage in your PayPal account ↗
							</a>
						</div>
					</PortalCard>

					<PortalCard title="Billing history">
						{history.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No billing history yet.
							</p>
						) : (
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-zinc-800 text-left text-xs text-muted-foreground">
										<th className="pb-2 font-medium">Date</th>
										<th className="pb-2 font-medium">Description</th>
										<th className="pb-2 text-right font-medium">Amount</th>
									</tr>
								</thead>
								<tbody>
									{history.map((entry, index) => (
										<tr
											// Ledger rows have no stable public id
											key={`${entry.date}-${index}`}
											className="border-b border-zinc-800/60 last:border-0"
										>
											<td className="py-2.5 text-zinc-300">
												{new Date(entry.date).toLocaleDateString("en-US", {
													year: "numeric",
													month: "short",
													day: "numeric",
												})}
											</td>
											<td className="py-2.5 text-zinc-300">
												{(entry.description ?? entry.kind)
													.replace(/^paypal-(capture|sale|invoice):/, "PayPal payment ")
													.replace(/-/g, " ")}
											</td>
											<td className="py-2.5 text-right tabular-nums text-zinc-300">
												{formatUsd(entry.amount_usd)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</PortalCard>
				</div>
			</div>
		</div>
	);
};
