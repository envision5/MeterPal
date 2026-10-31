import {
	CreditsBadge,
	LowBalanceBanner,
	PlanCard,
	TopUpModal,
	UsageHistoryPanel,
} from "@meterpal/sdk";
import { AutumnProvider } from "autumn-js/react";
import { useEffect, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };

const CUSTOMERS = ["demo-customer", "demo-customer-2"];

export default function App() {
	const [customerId, setCustomerId] = useState(CUSTOMERS[0]);

	return (
		// Keyed per customer: identity is resolved server-side from the
		// x-meterpal-customer header; remounting refreshes every billing query.
		<AutumnProvider
			key={customerId}
			backendUrl=""
			headers={{ "x-meterpal-customer": customerId }}
		>
			<Dashboard customerId={customerId} onCustomerChange={setCustomerId} />
		</AutumnProvider>
	);
}

function Dashboard({
	customerId,
	onCustomerChange,
}: {
	customerId: string;
	onCustomerChange: (id: string) => void;
}) {
	const setCustomerId = onCustomerChange;
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
	const [paypalClientId, setPaypalClientId] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/paypal/config")
			.then((r) => r.json())
			.then((d) => setPaypalClientId(d?.clientId ?? null))
			.catch(() => {});
	}, []);

	useEffect(() => {
		// PayPal browser-return landing: the billing server captured the
		// payment and redirected here (?payment=success&credits=N).
		const params = new URLSearchParams(window.location.search);
		const payment = params.get("payment");
		if (!payment) return;
		if (payment === "success") {
			const credits = params.get("credits");
			setPaymentNotice(
				credits
					? `✅ Payment captured — ${credits} credits added to your wallet.`
					: "✅ Payment captured — credits added to your wallet.",
			);
		} else if (payment === "cancelled") {
			setPaymentNotice("Payment cancelled — no charge was made.");
		} else {
			setPaymentNotice("⚠️ Payment could not be completed — try again.");
		}
		window.history.replaceState({}, "", window.location.pathname);
	}, []);

	async function send(prompt: string) {
		if (!prompt.trim() || busy) return;
		setMessages((m) => [...m, { role: "user", content: prompt }]);
		setInput("");
		setBusy(true);
		try {
			const res = await fetch("/api/chat", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-meterpal-customer": customerId,
				},
				body: JSON.stringify({ prompt }),
			});
			if (res.status === 402) {
				// Admission control refused the call before the model ran.
				setMessages((m) => [
					...m,
					{
						role: "assistant",
						content:
							"⛔ 402 — insufficient credits. The gateway refused this call " +
							"before the model provider was touched. Top up with PayPal to continue.",
					},
				]);
				window.dispatchEvent(new Event("open-topup-modal"));
				return;
			}
			const data = await res.json();
			setMessages((m) => [
				...m,
				{
					role: "assistant",
					content: data?.choices?.[0]?.message?.content ?? "(empty reply)",
				},
			]);
		} catch (err) {
			setMessages((m) => [
				...m,
				{ role: "assistant", content: `⚠️ request failed: ${String(err)}` },
			]);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mx-auto flex h-screen max-w-6xl flex-col gap-4 p-6">
			<header className="flex items-center justify-between gap-4">
				<div>
					<h1 className="text-xl font-bold">
						MeterPal <span className="text-muted-foreground">demo</span>
					</h1>
					<p className="text-xs text-muted-foreground">
						AI usage metered per call · wallet debited · PayPal buys the credits
					</p>
				</div>
				<div className="flex items-center gap-3">
					<select
						value={customerId}
						onChange={(e) => {
							setCustomerId(e.target.value);
							setMessages([]);
						}}
						className="rounded-md border border-border bg-background px-2 py-1 text-sm"
						data-testid="customer-switcher"
					>
						{CUSTOMERS.map((c) => (
							<option key={c} value={c}>
								{c}
							</option>
						))}
					</select>
					<CreditsBadge />
				</div>
			</header>

			{paymentNotice && (
				<div
					role="status"
					data-testid="payment-notice"
					className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100"
				>
					{paymentNotice}
				</div>
			)}

			<LowBalanceBanner
				onAddCredits={() => window.dispatchEvent(new Event("open-topup-modal"))}
			/>

			<main className="grid flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-[1fr_380px]">
				{/* chat */}
				<section className="flex flex-col overflow-hidden rounded-xl border border-border">
					<div className="flex-1 space-y-3 overflow-y-auto p-4">
						{messages.length === 0 && (
							<p className="text-sm text-muted-foreground">
								Send a message — each call is metered (token pools → base cost →
								markup → credits). Drain the wallet to see the 402 wall.
							</p>
						)}
						{messages.map((m, i) => (
							<div
								key={i}
								className={[
									"rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
									m.role === "user"
										? "ml-auto max-w-[80%] bg-primary text-primary-foreground"
										: "max-w-[90%] border border-border bg-muted",
								].join(" ")}
							>
								{m.content}
							</div>
						))}
						{busy && <p className="text-xs text-muted-foreground">thinking…</p>}
					</div>
					<form
						className="flex gap-2 border-t border-border p-3"
						onSubmit={(e) => {
							e.preventDefault();
							send(input);
						}}
					>
						<input
							value={input}
							onChange={(e) => setInput(e.target.value)}
							placeholder="Ask the demo model something…"
							className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
							data-testid="chat-input"
						/>
						<button
							type="submit"
							disabled={busy}
							className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
						>
							Send
						</button>
					</form>
				</section>

				{/* billing sidebar */}
				<aside className="flex flex-col gap-4 overflow-y-auto pr-1">
					<section className="rounded-xl border border-border p-4">
						<h2 className="mb-3 text-sm font-semibold">Top up (PayPal)</h2>
						<TopUpModal
							productIds={["topup_10", "topup_50", "topup_200"]}
							labels={["10 credits", "50 credits", "200 credits"]}
							prices={[10, 50, 200]}
							inPageCheckout={
								paypalClientId
									? {
											clientId: paypalClientId,
											capture: async (orderId: string) => {
												const res = await fetch(
													`/api/paypal/capture/${encodeURIComponent(orderId)}`,
													{ method: "POST" },
												);
												return res.json();
											},
										}
									: undefined
							}
							pollFinalize={async () => {
								const res = await fetch("/api/paypal/poll");
								if (!res.ok) return null;
								const data = await res.json();
								if (data?.status === "captured") {
									return { captured: true, credits: data.credits };
								}
								return { captured: false };
							}}
							onCaptured={(credits) => {
								setPaymentNotice(
									credits
										? `✅ Payment captured — ${credits} credits added to your wallet.`
										: "✅ Payment captured — credits added to your wallet.",
								);
							}}
						/>
						<button
							type="button"
							onClick={() => window.dispatchEvent(new Event("open-topup-modal"))}
							className="w-full rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
							data-testid="open-topup"
						>
							Buy credits with PayPal
						</button>
					</section>
					<section className="rounded-xl border border-border p-4">
						<h2 className="mb-3 text-sm font-semibold">Plans</h2>
						<PlanCard />
					</section>
					<section className="rounded-xl border border-border p-4">
						<h2 className="mb-3 text-sm font-semibold">Usage</h2>
						<UsageHistoryPanel />
					</section>
				</aside>
			</main>
		</div>
	);
}
