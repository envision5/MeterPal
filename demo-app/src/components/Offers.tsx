// demo-app/src/components/Offers.tsx
//
// The customer's side of agent proposals: a custom package the MERCHANT
// already approved ("your negotiated package is live"), and top-up
// authorizations the buyer agent drafted that wait for THIS customer's
// approval.  Accepting always goes through client.attach → PayPal's own
// approval; nothing here moves money by itself.

import { useCallback, useEffect, useState } from "react";
import { useAutumnClient } from "autumn-js/react";

type Proposal = {
	id: string;
	kind: "custom_package" | "topup_authorization";
	status: string;
	plan_id: string | null;
	payload: {
		name: string;
		credits: number;
		price_usd: number;
		reasoning: string;
		product_id?: string;
	};
};

export default function Offers({
	customerId,
	onNotice,
}: {
	customerId: string;
	onNotice: (msg: string) => void;
}) {
	const client = useAutumnClient({ caller: "Offers" });
	const [proposals, setProposals] = useState<Proposal[]>([]);
	const [busyId, setBusyId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/sales/offers", {
				headers: { "x-meterpal-customer": customerId },
			});
			const data = await res.json();
			setProposals(data?.proposals ?? []);
		} catch {
			/* keep the last list */
		}
	}, []);

	useEffect(() => {
		load();
		const timer = setInterval(load, 5000);
		window.addEventListener("offers-changed", load);
		return () => {
			clearInterval(timer);
			window.removeEventListener("offers-changed", load);
		};
	}, [load]);

	// A proposal-backed purchase completes on the PayPal redirect back to the
	// app; the landing effect in App.tsx marks it purchased via sessionStorage.
	useEffect(() => {
		const finalize = async () => {
			const raw = sessionStorage.getItem("agent-proposal-pending");
			if (!raw) return;
			sessionStorage.removeItem("agent-proposal-pending");
			const ids: string[] = JSON.parse(raw);
			for (const id of ids) {
				await fetch(`/api/sales/proposals/${encodeURIComponent(id)}/purchased`, {
					method: "POST",
					headers: { "x-meterpal-customer": customerId },
				}).catch(() => {});
			}
			load();
		};
		finalize();
	}, [load]);

	async function attach(planId: string | null, productId: string | null, proposalId: string) {
		const target = planId ?? productId;
		if (!target) return;
		setBusyId(proposalId);
		try {
			// Record the intent before leaving for PayPal; the landing effect
			// finalizes the status when the payment returns.
			sessionStorage.setItem(
				"agent-proposal-pending",
				JSON.stringify([proposalId]),
			);
			const result: any = await client.attach({ planId: target });
			const url =
				result?.paymentUrl ?? result?.payment_url ?? result?.checkout_url ?? result?.url;
			if (url) {
				window.location.href = url;
				return;
			}
			// No redirect (e.g. free or already active): finalize immediately.
			await fetch(`/api/sales/proposals/${encodeURIComponent(proposalId)}/purchased`, {
				method: "POST",
				headers: { "x-meterpal-customer": customerId },
			});
			onNotice("✅ Package active — credits are in your wallet.");
			load();
		} catch (err: any) {
			sessionStorage.removeItem("agent-proposal-pending");
			onNotice(`⚠️ Could not start checkout: ${err?.message ?? String(err)}`);
		} finally {
			setBusyId(null);
		}
	}

	async function decline(proposalId: string) {
		setBusyId(proposalId);
		try {
			await fetch(`/api/sales/proposals/${encodeURIComponent(proposalId)}/decline`, {
				method: "POST",
				headers: { "x-meterpal-customer": customerId },
			});
			load();
		} finally {
			setBusyId(null);
		}
	}

	const actionable = proposals.filter((p) =>
		["approved", "pending_customer"].includes(p.status),
	);
	const receipts = proposals.filter((p) => p.status === "purchased").slice(0, 3);

	if (actionable.length === 0 && receipts.length === 0) return null;

	return (
		<div className="space-y-3" data-testid="offers">
			{actionable.map((p) => (
				<div
					key={p.id}
					className="rounded-lg border border-border p-3 text-sm"
					data-testid="offer-card"
				>
					<div className="flex items-baseline justify-between gap-2">
						<span className="font-semibold">{p.payload.name}</span>
						<span data-testid="offer-price">
							{p.payload.credits} credits · ${p.payload.price_usd.toFixed(2)}
						</span>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">{p.payload.reasoning}</p>
					{p.kind === "topup_authorization" && (
						<p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
							Your agent asks to buy this pack (above your auto-approve line).
						</p>
					)}
					<div className="mt-2 flex gap-2">
						<button
							type="button"
							disabled={busyId === p.id}
							onClick={() => attach(p.plan_id, p.payload.product_id, p.id)}
							className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
							data-testid="offer-accept"
						>
							{busyId === p.id ? "Opening PayPal…" : "Accept & pay"}
						</button>
						{p.status === "pending_customer" && (
							<button
								type="button"
								disabled={busyId === p.id}
								onClick={() => decline(p.id)}
								className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
								data-testid="offer-decline"
							>
								Decline
							</button>
						)}
					</div>
				</div>
			))}
			{receipts.map((p) => (
				<p key={p.id} className="text-xs text-muted-foreground" data-testid="offer-receipt">
					✅ {p.payload.name} — {p.payload.credits} credits for $
					{p.payload.price_usd.toFixed(2)} (paid)
				</p>
			))}
		</div>
	);
}
