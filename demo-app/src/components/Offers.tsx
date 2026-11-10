// demo-app/src/components/Offers.tsx
//
// The customer's side of agent proposals: a custom package the MERCHANT
// already approved ("your negotiated package is live"), and top-up
// authorizations the buyer agent drafted that wait for THIS customer's
// approval.  Accepting always goes through client.attach → PayPal's own
// approval; nothing here moves money by itself.
//
// Proposals are polled by useOffers at App level (so the tab can badge while
// closed); this component just renders them.

import {
	IconBrandPaypal,
	IconCheck,
	IconClock,
	IconGift,
	IconReceipt,
	IconRobot,
	IconX,
} from "@tabler/icons-react";
import { useState } from "react";
import { useAutumnClient } from "autumn-js/react";
import { authHeaders } from "../customerIdentity";
import type { Proposal } from "../useOffers";

export default function Offers({
	customerId,
	proposals,
	reload,
	onNotice,
}: {
	customerId: string;
	proposals: Proposal[];
	reload: () => void | Promise<void>;
	onNotice: (msg: string) => void;
}) {
	const client = useAutumnClient({ caller: "Offers" });
	const [busyId, setBusyId] = useState<string | null>(null);

	async function attach(
		planId: string | null,
		productId: string | null,
		proposalId: string,
	) {
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
				result?.paymentUrl ??
				result?.payment_url ??
				result?.checkout_url ??
				result?.url;
			if (url) {
				window.location.href = url;
				return;
			}
			// No redirect (e.g. free or already active): finalize immediately.
			await fetch(`/api/sales/proposals/${encodeURIComponent(proposalId)}/purchased`, {
				method: "POST",
				headers: authHeaders(customerId),
			});
			onNotice("✅ Package active — credits are in your wallet.");
			reload();
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
				headers: authHeaders(customerId),
			});
			reload();
		} finally {
			setBusyId(null);
		}
	}

	const actionable = proposals.filter((p) =>
		["approved", "pending_customer"].includes(p.status),
	);
	const receipts = proposals.filter((p) => p.status === "purchased").slice(0, 3);

	if (actionable.length === 0 && receipts.length === 0) {
		return (
			<p className="text-xs text-muted-foreground" data-testid="offers-empty">
				Nothing here yet. Negotiate in the sales tab — approved packages land
				here ready to buy.
			</p>
		);
	}

	return (
		<div className="space-y-3" data-testid="offers">
			{actionable.map((p) => (
				<div
					key={p.id}
					className={[
						"rounded-xl border p-3",
						p.status === "pending_customer"
							? "border-amber-500/40 bg-amber-500/[0.06]"
							: "border-emerald-500/40 bg-emerald-500/[0.06]",
					].join(" ")}
					data-testid="offer-card"
				>
					<div className="flex items-center gap-2">
						<span
							className={[
								"flex size-8 shrink-0 items-center justify-center rounded-lg",
								p.status === "pending_customer"
									? "bg-amber-500/15 text-amber-300"
									: "bg-emerald-500/15 text-emerald-300",
							].join(" ")}
						>
							{p.kind === "topup_authorization" ? (
								<IconRobot size={16} />
							) : (
								<IconGift size={16} />
							)}
						</span>
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-semibold">{p.payload.name}</p>
							<p className="text-xs text-muted-foreground">
								{p.payload.credits} credits · $
								{p.payload.price_usd.toFixed(2)}
							</p>
						</div>
					</div>
					<p className="mt-2 text-xs text-muted-foreground">
						{p.payload.reasoning}
					</p>
					{p.status === "pending_customer" && (
						<p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-300">
							<IconClock size={12} />
							Your agent asks to buy this — above your auto-approve line
						</p>
					)}
					<div className="mt-2.5 flex gap-2">
						<button
							type="button"
							disabled={busyId === p.id}
							onClick={() => attach(p.plan_id, p.payload.product_id ?? null, p.id)}
							className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-300 disabled:opacity-50"
							data-testid="offer-accept"
						>
							<IconBrandPaypal size={14} />
							{busyId === p.id ? "Opening PayPal…" : "Accept & pay"}
						</button>
						{p.status === "pending_customer" && (
							<button
								type="button"
								disabled={busyId === p.id}
								onClick={() => decline(p.id)}
								className="flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
								data-testid="offer-decline"
								title="Decline"
							>
								<IconX size={14} />
							</button>
						)}
					</div>
				</div>
			))}
			{receipts.map((p) => (
				<p
					key={p.id}
					className="flex items-center gap-1.5 text-xs text-muted-foreground"
					data-testid="offer-receipt"
				>
					<IconReceipt size={13} className="text-emerald-400" />
					{p.payload.name} — {p.payload.credits} credits for $
					{p.payload.price_usd.toFixed(2)}
					<span className="ml-1 inline-flex items-center gap-0.5 text-emerald-400">
						<IconCheck size={12} />
						paid
					</span>
				</p>
			))}
		</div>
	);
}
