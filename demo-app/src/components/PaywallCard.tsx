// demo-app/src/components/PaywallCard.tsx
//
// The 402 moment, as a first-class component — this is the product: the call
// was refused BEFORE the provider was touched, and the buyer agent's decision
// is rendered right here (initiated / waiting for approval / stood down).

import {
	IconAlertTriangle,
	IconArrowRight,
	IconBrandPaypal,
	IconCoins,
	IconLock,
	IconRobot,
	IconWallet,
} from "@tabler/icons-react";

export type PaywallData = {
	balance?: number;
	requiredCredits?: number;
	agent_action?: "initiated" | "approval_required" | "denied";
	agent_reason?: string;
	agent_pack?: { credits: number; price_usd: number; product_id: string };
	checkout?: { product_id: string; url: string | null };
};

export default function PaywallCard({
	data,
	onTopUp,
}: {
	data: PaywallData;
	onTopUp: () => void;
}) {
	const agent =
		data.agent_action === "initiated" ? (
			<div className="flex items-start gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 p-3">
				<IconRobot size={18} className="mt-0.5 shrink-0 text-violet-300" />
				<div className="text-xs">
					<p className="font-medium text-violet-200">
						Your agent is on it — buying {data.agent_pack?.credits} credits for $
						{data.agent_pack?.price_usd?.toFixed(2)} within your mandate
					</p>
					<p className="mt-0.5 text-violet-300/80">{data.agent_reason}</p>
					{data.checkout?.url && (
						<a
							href={data.checkout.url}
							target="_blank"
							rel="noreferrer"
							className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-300"
							data-testid="paywall-paypal-link"
						>
							<IconBrandPaypal size={14} />
							Approve in PayPal
							<IconArrowRight size={14} />
						</a>
					)}
				</div>
			</div>
		) : data.agent_action === "approval_required" ? (
			<div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
				<IconRobot size={18} className="mt-0.5 shrink-0 text-amber-300" />
				<div className="text-xs">
					<p className="font-medium text-amber-200">
						Your agent drafted a top-up — {data.agent_pack?.credits} credits for $
						{data.agent_pack?.price_usd?.toFixed(2)} — above your auto-approve
						line
					</p>
					<p className="mt-0.5 text-amber-300/80">{data.agent_reason}</p>
					<p className="mt-2 inline-flex items-center gap-1 text-amber-200">
						Waiting for you in the <strong>Offers</strong> rail
						<IconArrowRight size={13} />
					</p>
				</div>
			</div>
		) : data.agent_action === "denied" ? (
			<div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3">
				<IconAlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-300" />
				<div className="text-xs text-rose-200">
					<p className="font-medium">Your agent stood down</p>
					<p className="mt-0.5 text-rose-300/80">{data.agent_reason}</p>
				</div>
			</div>
		) : null;

	return (
		<div
			className="overflow-hidden rounded-2xl border border-rose-500/50 bg-rose-500/[0.07]"
			data-testid="paywall-card"
		>
			<div className="flex items-start gap-3 p-4">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-300">
					<IconLock size={20} />
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-semibold text-rose-200">
						402 — call refused before any spend
					</p>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Admission control stopped the request before the model provider was
						touched. Nothing was billed for a call that never ran.
					</p>
					<div className="mt-2 flex flex-wrap gap-1.5">
						<span className="mp-chip">
							<IconWallet size={12} className="text-amber-300" />
							balance {typeof data.balance === "number" ? data.balance.toFixed(2) : data.balance}
						</span>
						<span className="mp-chip">
							<IconCoins size={12} className="text-rose-300" />
							needed {data.requiredCredits}
						</span>
					</div>
					{agent && <div className="mt-3">{agent}</div>}
					{data.agent_action !== "initiated" && (
						<button
							type="button"
							onClick={onTopUp}
							className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3.5 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-300"
							data-testid="paywall-topup"
						>
							<IconBrandPaypal size={15} />
							Top up with PayPal
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
