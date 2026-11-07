import {
	IconBolt,
	IconBrandPaypal,
	IconChartBar,
	IconCoins,
	IconGift,
	IconLock,
	IconRobot,
	IconSend,
	IconShieldCheck,
	IconUser,
	IconWallet,
} from "@tabler/icons-react";
import { AutumnProvider, useCustomer } from "autumn-js/react";
import { useEffect, useState } from "react";
import { PlanCard, TopUpModal, UsageHistoryPanel } from "@meterpal/sdk";
import AgentSettings from "./components/AgentSettings";
import Offers from "./components/Offers";
import PaywallCard, { type PaywallData } from "./components/PaywallCard";
import SalesChat from "./components/SalesChat";
import SpendAlerts from "./components/SpendAlerts";

type Message = {
	role: "user" | "assistant";
	content: string;
	/** Credits this turn cost, when it was a metered call. */
	charged?: number;
	/** Token counts for the metering chip. */
	tokens?: { input: number; output: number };
	/** The 402 moment, when admission control refused the call. */
	paywall?: PaywallData;
};

type ServedModel = {
	model_id: string;
	display_name: string | null;
	enabled: boolean;
	input_cost_usd_1m: number | null;
	output_cost_usd_1m: number | null;
};

const CUSTOMERS = ["demo-customer", "demo-customer-2"];

type RailTab = "wallet" | "agent" | "offers" | "usage";

const RAIL_TABS: { id: RailTab; label: string; icon: typeof IconWallet }[] = [
	{ id: "wallet", label: "Wallet", icon: IconWallet },
	{ id: "agent", label: "Agent", icon: IconRobot },
	{ id: "offers", label: "Offers", icon: IconGift },
	{ id: "usage", label: "Usage", icon: IconChartBar },
];

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

function WalletPill() {
	const { data: customer } = useCustomer();
	const balance = customer?.balances?.ai_tokens?.remaining;
	const unlimited = customer?.balances?.ai_tokens?.unlimited;
	const low = typeof balance === "number" && balance < 1;

	return (
		<div
			className="flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-sm font-semibold text-amber-200"
			data-testid="wallet-pill"
			title="The customer's credit wallet — every call debits it"
		>
			<IconWallet size={15} />
			{unlimited ? "∞" : typeof balance === "number" ? balance.toFixed(2) : "—"}
			<span className="text-[10px] font-normal text-amber-200/70">credits</span>
			{low && !unlimited && (
				<span className="size-1.5 animate-pulse rounded-full bg-rose-400" />
			)}
		</div>
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
	const [models, setModels] = useState<ServedModel[]>([]);
	const [modelId, setModelId] = useState("custom/demo-gpt");
	const [chatTab, setChatTab] = useState<"assistant" | "sales">("assistant");
	const [railTab, setRailTab] = useState<RailTab>("wallet");

	useEffect(() => {
		fetch("/api/paypal/config")
			.then((r) => r.json())
			.then((d) => setPaypalClientId(d?.clientId ?? null))
			.catch(() => {});
	}, []);

	// The models this merchant serves, with their prices.  This is the
	// merchant's own price sheet -- the app shows exactly what it may call
	// and what it charges.
	useEffect(() => {
		fetch("/api/models")
			.then((r) => r.json())
			.then((d) => {
				const served: ServedModel[] = d?.models ?? [];
				setModels(served);
				const firstEnabled = served.find((m) => m.enabled);
				if (firstEnabled) setModelId(firstEnabled.model_id);
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		// PayPal browser-return landing.  Two shapes:
		//   ?payment=success&credits=N     -> a one-off credit pack was captured
		//   ?payment=success&subscription=activated -> a PayPal SUBSCRIPTION was
		//                                     approved and the plan switched
		// They are different events and must not claim the same thing.
		const params = new URLSearchParams(window.location.search);
		const payment = params.get("payment");
		if (!payment) return;
		if (payment === "success") {
			const credits = params.get("credits");
			const subscription = params.get("subscription");
			if (subscription === "activated") {
				setPaymentNotice(
					"✅ PayPal subscription active — your plan has been switched and your new allowance is live.",
				);
			} else {
				setPaymentNotice(
					credits
						? `✅ Payment captured — ${credits} credits added to your wallet.`
						: "✅ Payment captured.",
				);
			}
		} else if (payment === "cancelled") {
			setPaymentNotice("Payment cancelled — no charge was made.");
		} else {
			const reason = params.get("reason");
			setPaymentNotice(
				reason
					? `⚠️ Payment could not be completed (${reason}) — try again.`
					: "⚠️ Payment could not be completed — try again.",
			);
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
				body: JSON.stringify({ prompt, model: modelId }),
			});
			if (res.status === 402) {
				// Admission control refused the call before the model ran — the
				// paywall card carries the buyer agent's decision with it.
				const data = await res.json().catch(() => ({}));
				setMessages((m) => [
					...m,
					{
						role: "assistant",
						content:
							data?.agent_action === "initiated"
								? "Your agent stepped in."
								: data?.agent_action === "approval_required"
									? "Your agent drafted a top-up for your approval."
									: data?.agent_action === "denied"
										? "Your agent stood down."
										: "Call refused.",
						paywall: data,
					},
				]);
				return;
			}
			const data = await res.json();
			setMessages((m) => [
				...m,
				{
					role: "assistant",
					content: data?.choices?.[0]?.message?.content ?? "(empty reply)",
					charged: data?.meterpal?.credits_charged ?? undefined,
					tokens: data?.meterpal
						? {
								input: data.meterpal.input_tokens ?? 0,
								output: data.meterpal.output_tokens ?? 0,
							}
						: undefined,
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
		<div className="mx-auto flex h-screen max-w-7xl flex-col p-4">
			<header className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2.5">
					<span className="flex size-9 items-center justify-center rounded-xl bg-primary/20 text-primary">
						<IconBolt size={20} />
					</span>
					<div>
						<h1 className="text-base font-bold leading-tight">MeterPal</h1>
						<p className="text-[11px] leading-tight text-muted-foreground">
							metered AI · hard paywall · PayPal
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<select
						value={customerId}
						onChange={(e) => {
							setCustomerId(e.target.value);
							setMessages([]);
						}}
						className="rounded-full border border-border bg-muted/60 px-3 py-1.5 text-xs outline-none"
						data-testid="customer-switcher"
						title="The end user being billed"
					>
						{CUSTOMERS.map((c) => (
							<option key={c} value={c}>
								{c}
							</option>
						))}
					</select>
					<select
						value={modelId}
						onChange={(e) => setModelId(e.target.value)}
						className="max-w-[240px] rounded-full border border-border bg-muted/60 px-3 py-1.5 text-xs outline-none"
						data-testid="model-switcher"
						title="The models this merchant serves, and what they charge"
					>
						{models.map((m) => (
							<option key={m.model_id} value={m.model_id}>
								{m.display_name ?? m.model_id} · ${m.input_cost_usd_1m}/$
								{m.output_cost_usd_1m} per 1M
							</option>
						))}
					</select>
					<WalletPill />
				</div>
			</header>

			{paymentNotice && (
				<div
					role="status"
					data-testid="payment-notice"
					className="mt-3 rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-900 dark:text-emerald-100"
				>
					{paymentNotice}
				</div>
			)}

			<SpendAlerts customerId={customerId} />

			<main className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_400px]">
				{/* conversation canvas */}
				<section className="flex min-h-0 flex-col rounded-2xl border border-border bg-muted/20">
					<div className="flex items-center gap-1 border-b border-border px-3 py-2">
						<button
							type="button"
							onClick={() => setChatTab("assistant")}
							className={[
								"flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition",
								chatTab === "assistant"
									? "bg-primary/20 text-foreground"
									: "text-muted-foreground hover:text-foreground",
							].join(" ")}
							data-testid="tab-assistant"
						>
							<IconBolt size={14} />
							Assistant
						</button>
						<button
							type="button"
							onClick={() => setChatTab("sales")}
							className={[
								"flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition",
								chatTab === "sales"
									? "bg-violet-500/20 text-violet-200"
									: "text-muted-foreground hover:text-foreground",
							].join(" ")}
							data-testid="tab-sales"
						>
							<IconRobot size={14} />
							Talk to sales
						</button>
					</div>

					{chatTab === "sales" ? (
						<SalesChat customerId={customerId} />
					) : (
						<div className="flex min-h-0 flex-1 flex-col">
							<div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
								{messages.length === 0 && (
									<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
										<span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
											<IconBolt size={26} />
										</span>
										<p className="text-sm font-medium">
											Every call is metered, admitted, and charged.
										</p>
										<div className="flex flex-wrap justify-center gap-1.5">
											<span className="mp-chip">
												<IconCoins size={12} className="text-amber-300" />
												per-token → cost → credits
											</span>
											<span className="mp-chip">
												<IconLock size={12} className="text-rose-300" />
												402 before any model spend
											</span>
											<span className="mp-chip">
												<IconRobot size={12} className="text-violet-300" />
												your agent handles the paywall
											</span>
										</div>
										<p className="max-w-md text-xs text-muted-foreground">
											Send a message — token pools → base cost → markup →
											credits, debited from the wallet atomically. Drain it to
											see the wall.
										</p>
									</div>
								)}
								{messages.map((m, i) =>
									m.role === "user" ? (
										<div
											key={i}
											className="mp-bubble-user"
											data-testid="chat-user-msg"
										>
											{m.content}
										</div>
									) : (
										<div key={i} className="mp-msg-agent">
											<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
												<IconBolt size={15} />
											</span>
											<div className="min-w-0 flex-1 space-y-1.5">
												<p className="text-[11px] font-semibold text-muted-foreground">
													Assistant
												</p>
												<div className="whitespace-pre-wrap text-sm">
													{m.content}
												</div>
												{m.charged !== undefined && (
													<div
														className="flex flex-wrap items-center gap-1.5"
														data-testid="chat-charge"
													>
														<span className="mp-chip !text-amber-200">
															<IconCoins size={11} className="text-amber-300" />
															charged {m.charged} credits
														</span>
														{m.tokens && (
															<span className="mp-chip">
																{m.tokens.input.toLocaleString()} in /{" "}
																{m.tokens.output.toLocaleString()} out
															</span>
														)}
													</div>
												)}
												{m.paywall && (
													<PaywallCard
														data={m.paywall}
														onTopUp={() =>
															window.dispatchEvent(new Event("open-topup-modal"))
														}
													/>
												)}
											</div>
										</div>
									),
								)}
								{busy && (
									<div className="mp-msg-agent">
										<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
											<IconBolt size={15} />
										</span>
										<p className="text-xs text-muted-foreground">thinking…</p>
									</div>
								)}
							</div>
							<form
								className="px-4 pb-4"
								onSubmit={(e) => {
									e.preventDefault();
									send(input);
								}}
							>
								<div className="mp-composer">
									<input
										value={input}
										onChange={(e) => setInput(e.target.value)}
										placeholder="Ask the demo model something…"
										className="mp-composer-input"
										data-testid="chat-input"
									/>
									<button
										type="submit"
										disabled={busy}
										className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
										data-testid="chat-send"
										title="Send (metered per token)"
									>
										<IconSend size={17} />
									</button>
								</div>
								<p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
									Each send is admitted against the wallet, then metered per
									token from the merchant's price sheet.
								</p>
							</form>
						</div>
					)}
				</section>

				{/* billing rail */}
				<aside className="flex min-h-0 flex-col rounded-2xl border border-border bg-muted/20">
					<div className="flex gap-1 border-b border-border p-2">
						{RAIL_TABS.map(({ id, label, icon: Icon }) => (
							<button
								key={id}
								type="button"
								onClick={() => setRailTab(id)}
								className={`mp-rail-tab ${railTab === id ? "mp-rail-tab-active" : ""}`}
								data-testid={`rail-${id}`}
							>
								<Icon size={14} />
								{label}
							</button>
						))}
					</div>
					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
						{railTab === "wallet" && (
							<>
								<section className="mp-card p-4">
									<h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
										<IconBrandPaypal size={16} className="text-amber-300" />
										Top up with PayPal
									</h2>
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
										onClick={() =>
											window.dispatchEvent(new Event("open-topup-modal"))
										}
										className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/20"
										data-testid="open-topup"
									>
										<IconBrandPaypal size={16} />
										Buy credits
									</button>
								</section>
								<section className="mp-card p-4">
									<h2 className="mb-3 text-sm font-semibold">Plans</h2>
									<PlanCard />
								</section>
							</>
						)}
						{railTab === "agent" && (
							<section className="mp-card p-4">
								<h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
									<IconShieldCheck size={16} className="text-violet-300" />
									Buyer agent mandate
								</h2>
								<AgentSettings customerId={customerId} />
							</section>
						)}
						{railTab === "offers" && (
							<section className="mp-card p-4">
								<h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
									<IconGift size={16} className="text-emerald-300" />
									Agent offers
								</h2>
								<p className="mb-3 text-xs text-muted-foreground">
									Packages your sales-agent negotiation produced
									(merchant-approved) and top-ups your buyer agent is waiting
									on you for.
								</p>
								<Offers customerId={customerId} onNotice={setPaymentNotice} />
							</section>
						)}
						{railTab === "usage" && (
							<section className="mp-card p-4">
								<h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
									<IconChartBar size={16} className="text-sky-300" />
									Usage ledger
								</h2>
								<UsageHistoryPanel />
							</section>
						)}
					</div>
				</aside>
			</main>
		</div>
	);
}
