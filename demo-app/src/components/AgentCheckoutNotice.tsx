// demo-app/src/components/AgentCheckoutNotice.tsx
//
// The durable half of the paywall moment: the buyer agent opened a PayPal
// checkout and the human hasn't approved it yet.  The chat paywall card dies
// with the message list (refresh, customer switch, tab wander); this banner
// is backed by server state, so the "approve in PayPal" ask — with the
// agent's own description of the charge — keeps coming back until PayPal
// settles the order one way or the other.  Also raises a desktop
// notification when the user has opted in.

import { IconBell, IconBrandPaypal, IconRobot, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "../customerIdentity";

type PendingCheckout = {
	product_id: string;
	credits: number;
	price_usd: number;
	reason: string;
	url: string;
	created_at: number;
};

function ago(ts: number): string {
	const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	return `${Math.round(mins / 60)} h ago`;
}

export default function AgentCheckoutNotice({
	customerId,
	onNotice,
}: {
	customerId: string;
	onNotice: (msg: string) => void;
}) {
	const [checkout, setCheckout] = useState<PendingCheckout | null>(null);
	const [permission, setPermission] = useState<string>(
		typeof Notification !== "undefined" ? Notification.permission : "denied",
	);
	// One desktop notification per checkout — the poll reruns every few
	// seconds and must not nag.
	const notifiedFor = useRef<string | null>(null);

	const notify = (pending: PendingCheckout) => {
		const key = `${pending.created_at}:${pending.product_id}`;
		if (notifiedFor.current === key) return;
		if (
			typeof Notification === "undefined" ||
			Notification.permission !== "granted"
		)
			return;
		notifiedFor.current = key;
		try {
			const n = new Notification("MeterPal — your agent needs your approval", {
				body: `Approve $${pending.price_usd.toFixed(2)} for ${pending.credits} credits at PayPal: ${pending.reason}`,
				tag: `meterpal-agent-checkout-${pending.product_id}`,
			});
			n.onclick = () => {
				window.focus();
				window.open(pending.url, "_blank", "noreferrer");
			};
		} catch {
			/* notification API unavailable in this context */
		}
	};

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/agent/pending-checkout", {
				headers: authHeaders(customerId),
			});
			// A failed read says nothing about the checkout; the last known
			// state (the banner) is the better answer than a blank page.
			if (!res.ok) return;
			const data = await res.json();
			if (data?.pending && data?.checkout?.url) {
				setCheckout(data.checkout);
				notify(data.checkout);
			} else {
				setCheckout(null);
				if (data?.captured) {
					onNotice(
						data.credits
							? `✅ Payment captured — ${data.credits} credits added to your wallet.`
							: "✅ Payment captured — credits added to your wallet.",
					);
				}
			}
		} catch {
			/* keep the last known state */
		}
	}, [customerId, onNotice]);

	useEffect(() => {
		load();
		const timer = setInterval(load, 4000);
		window.addEventListener("agent-checkout-changed", load);
		return () => {
			clearInterval(timer);
			window.removeEventListener("agent-checkout-changed", load);
		};
	}, [load]);

	async function dismiss() {
		setCheckout(null);
		try {
			await fetch("/api/agent/pending-checkout", {
				method: "DELETE",
				headers: authHeaders(customerId),
			});
		} catch {
			/* banner stays hidden regardless */
		}
	}

	if (!checkout) return null;

	return (
		<div
			role="alert"
			data-testid="agent-checkout-notice"
			className="rounded-xl border border-violet-500/50 bg-violet-500/10 px-4 py-2.5 text-sm"
		>
			<div className="flex items-start gap-2.5">
				<IconRobot size={17} className="mt-0.5 shrink-0 text-violet-500 dark:text-violet-300" />
				<div className="min-w-0 flex-1">
					<p className="font-medium text-violet-900 dark:text-violet-100">
						Your agent is buying {checkout.credits} credits for $
						{checkout.price_usd.toFixed(2)} — it needs your PayPal approval
					</p>
					<p className="mt-0.5 text-xs text-violet-700 dark:text-violet-300/80">
						{checkout.reason} · requested {ago(checkout.created_at)}
					</p>
				</div>
				<a
					href={checkout.url}
					target="_blank"
					rel="noreferrer"
					className="flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-300"
					data-testid="agent-checkout-approve"
				>
					<IconBrandPaypal size={14} />
					Approve in PayPal
				</a>
				{permission === "default" && (
					<button
						type="button"
						title="Get a desktop notification when your agent asks for approval"
						onClick={async () => {
							try {
								setPermission(await Notification.requestPermission());
							} catch {
								setPermission("denied");
							}
						}}
						className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
						data-testid="enable-notifications"
					>
						<IconBell size={14} />
					</button>
				)}
				<button
					type="button"
					onClick={dismiss}
					title="Dismiss — you can still top up manually"
					className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
					data-testid="agent-checkout-dismiss"
				>
					<IconX size={14} />
				</button>
			</div>
		</div>
	);
}
