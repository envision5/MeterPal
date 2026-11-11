import {
	IconBolt,
	IconBrandPaypal,
	IconChartBar,
	IconCoins,
	IconGift,
	IconLock,
	IconRobot,
	IconRosetteDiscountCheck,
	IconSend,
	IconShieldCheck,
	IconUser,
	IconWallet,
} from "@tabler/icons-react";
import { AutumnProvider } from "autumn-js/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	PlanCard,
	TopUpModal,
	UsageHistoryPanel,
	useCurrentPlan,
} from "@meterpal/sdk";
import AgentSettings from "./components/AgentSettings";
import { authHeaders, loadCustomerTokens } from "./customerIdentity";
import AgentCheckoutNotice from "./components/AgentCheckoutNotice";
import Offers from "./components/Offers";
import PaywallCard, { type PaywallData } from "./components/PaywallCard";
import SalesChat from "./components/SalesChat";
import SpendAlerts from "./components/SpendAlerts";
import { useOffers } from "./useOffers";
// The official white wordmark already carries the gauge mark and the name --
// the header is just this one asset, with no companion text. Imported straight
// from the brand source so a re-brand needs no copy step for the demo header.
import meterpalWordmark from "../../assets/images/logo-white.svg";

type Message = {
	role: "user" | "assistant";
	content: string;
	/** Stable key: a streamed reply is patched in place as tokens arrive, so
	 *  its position in the list is not a safe identity. */
	id?: string;
	/** Credits this turn cost, when it was a metered call. */
	charged?: number;
	/** Token counts for the metering chip. `input`/`output` are the totals the
	 *  charge was computed from (cached input and reasoning included), and
	 *  `cacheRead`/`reasoning` are the parts of them billed through their own
	 *  pool — shown so the chip's arithmetic can be checked against the
	 *  merchant's rate sheet. */
	tokens?: {
		input: number;
		output: number;
		cacheRead?: number;
		reasoning?: number;
	};
	/** The 402 moment, when admission control refused the call. */
	paywall?: PaywallData;
	/** Still arriving — drives the caret and the "thinking" state. */
	streaming?: boolean;
	/** The live meter while it arrives: tokens seen and credits accrued. */
	live?: { tokens: number; credits: number };
};

type ServedModel = {
	model_id: string;
	display_name: string | null;
	enabled: boolean;
	input_cost_usd_1m: number | null;
	output_cost_usd_1m: number | null;
};

const CUSTOMERS = ["demo-customer", "demo-customer-2"];

/** Which persona the switcher is on, remembered across reloads. */
const CUSTOMER_STORAGE_KEY = "meterpal.demo.customer";

/**
 * What a partially-streamed reply has cost so far, priced at the merchant's
 * own published rates — the same sheet the model picker shows and the same
 * one the server pins when it admits the call.
 *
 * It is an estimate for exactly one reason: the input token count is not
 * known until the call ends.  Text length is the standard approximation
 * (~4 characters per token), and the exact charge replaces it the moment the
 * meterpal block arrives.
 */
const estimateCredits = (
	model: ServedModel | undefined,
	inputChars: number,
	outputChars: number,
): number => {
	if (!model) return 0;
	const inputTokens = Math.max(1, Math.round(inputChars / 4));
	const outputTokens = Math.round(outputChars / 4);
	return (
		(inputTokens * (model.input_cost_usd_1m ?? 0) +
			outputTokens * (model.output_cost_usd_1m ?? 0)) /
		1_000_000
	);
};

type RailTab = "wallet" | "agent" | "offers" | "usage";

const RAIL_TABS: { id: RailTab; label: string; icon: typeof IconWallet }[] = [
	{ id: "wallet", label: "Wallet", icon: IconWallet },
	{ id: "agent", label: "Agent", icon: IconRobot },
	{ id: "offers", label: "Offers", icon: IconGift },
	{ id: "usage", label: "Usage", icon: IconChartBar },
];

// ---- automatic PayPal hand-off for the buyer agent ----
// The 402 arrives several hops after the user's click (admission -> ledger
// reads -> PayPal order creation), so a window.open() at that point is past
// the browser's user-activation window and usually gets blocked.  When the
// wallet is already low we open a named popup ON the click and navigate it as
// soon as the agent returns the approval URL.  No extra button click: the
// agent creates the order and the browser lands on PayPal's login/approval.
const APPROVAL_WINDOW_NAME = "meterpal-paypal-approval";
const PAYMENT_RETURN_CHANNEL = "meterpal:payment-return";
// A cross-origin round trip through PayPal can sever window.opener.  The
// popup leaves itself this marker before navigating, so the return document
// can still recognise itself when it lands back on our origin.
const APPROVAL_POPUP_MARKER = "meterpal:approval-popup";

type PaymentReturn = {
	payment: string | null;
	credits: string | null;
	subscription: string | null;
	reason: string | null;
};

let activeApprovalWindow: Window | null = null;

function prepareApprovalWindow(): Window | null {
	// Never open a second approval while one is already with PayPal.
	if (activeApprovalWindow && !activeApprovalWindow.closed) return null;
	try {
		const popup = window.open(
			"",
			APPROVAL_WINDOW_NAME,
			"popup,width=560,height=780",
		);
		if (!popup) return null;
		// Reusing a named window that has already navigated would wipe the
		// PayPal page the user is logging into.  Cross-origin reads throw.
		try {
			if (popup.location.href !== "about:blank") return null;
		} catch {
			return null;
		}
		popup.document.write(
			'<!doctype html><html><head><meta charset="utf-8"><title>MeterPal · PayPal</title>' +
				"<style>body{margin:0;background:#101215;color:#e9e9ec;font:14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}p{opacity:.75}</style></head>" +
				"<body><p>Preparing your agent's PayPal approval…</p></body></html>",
		);
		popup.document.close();
		// about:blank inherits our origin, so this popup has its own
		// sessionStorage area.  The marker survives the PayPal redirect back
		// to this origin even if window.opener does not.
		try {
			popup.sessionStorage.setItem(APPROVAL_POPUP_MARKER, "1");
		} catch {
			/* storage unavailable — window.opener is the fallback signal */
		}
		activeApprovalWindow = popup;
		return popup;
	} catch {
		return null;
	}
}

function openApproval(url: string, prepared: Window | null): boolean {
	try {
		if (prepared && !prepared.closed) {
			prepared.location.replace(url);
			prepared.focus();
			activeApprovalWindow = prepared;
			return true;
		}
		// An earlier approval is still open — do not navigate it away.
		if (activeApprovalWindow && !activeApprovalWindow.closed) return false;
		const fallback = window.open(
			url,
			APPROVAL_WINDOW_NAME,
			"popup,width=560,height=780",
		);
		if (!fallback) return false;
		activeApprovalWindow = fallback;
		return true;
	} catch {
		return false;
	}
}

function closeApprovalWindow(popup: Window | null) {
	try {
		if (popup && !popup.closed) popup.close();
	} catch {
		/* popup already gone */
	}
	if (activeApprovalWindow === popup) activeApprovalWindow = null;
}

/** PayPal returned: the popup closes itself, so just drop our guard. */
function clearApprovalWindow() {
	activeApprovalWindow = null;
}

function paymentNoticeFor(p: PaymentReturn): string {
	if (p.payment === "success") {
		if (p.subscription === "activated") {
			return "✅ PayPal subscription active — your plan has been switched and your new allowance is live.";
		}
		return p.credits
			? `✅ Payment captured — ${p.credits} credits added to your wallet.`
			: "✅ Payment captured.";
	}
	if (p.payment === "cancelled") return "Payment cancelled — no charge was made.";
	return p.reason
		? `⚠️ Payment could not be completed (${p.reason}) — try again.`
		: "⚠️ Payment could not be completed — try again.";
}

/** The approval popup lands back on this app after PayPal captures.  Hand the
 *  result to the main window, which is still showing the chat thread. */
function publishPaymentReturn(payload: PaymentReturn) {
	try {
		const channel = new BroadcastChannel(PAYMENT_RETURN_CHANNEL);
		channel.postMessage(payload);
		// Do not close immediately: delivery is queued, and this popup is
		// about to close itself after the return is handed back.
	} catch {
		/* BroadcastChannel unsupported */
	}
	try {
		if (window.opener && window.opener !== window) {
			window.opener.postMessage(
				{ type: PAYMENT_RETURN_CHANNEL, ...payload },
				window.location.origin,
			);
		}
	} catch {
		/* opener closed in the meantime */
	}
}

/** Is THIS document the agent's approval popup, rather than the chat window?
 *  window.opener is the normal signal; the sessionStorage marker covers the
 *  browsers that drop the opener across PayPal's cross-origin redirect. */
function isApprovalPopupWindow(): boolean {
	if (window.opener && window.opener !== window) return true;
	try {
		return sessionStorage.getItem(APPROVAL_POPUP_MARKER) === "1";
	} catch {
		return false;
	}
}

type TopUp = { id: string; label: string; price: number };

const FALLBACK_TOPUPS: TopUp[] = [
	{ id: "topup_10", label: "10 credits", price: 10 },
	{ id: "topup_50", label: "50 credits", price: 50 },
	{ id: "topup_200", label: "200 credits", price: 200 },
];

export default function App() {
	// Personas and top-up packs come from the binding the merchant's setup
	// wrote (see /api/config), so pointing the stack at a different org is
	// enough to change what this app sells — no code edit.
	const [customers, setCustomers] = useState<string[]>(CUSTOMERS);
	// Remembered across reloads. The switcher is how a viewer moves between
	// "funded" and "paywalled", and a reload snapping back to the first
	// persona made the second one feel like a mode you had to re-enter after
	// every refresh — during a demo, every refresh.
	const [customerId, setCustomerId] = useState(() => {
		try {
			return window.localStorage.getItem(CUSTOMER_STORAGE_KEY) || CUSTOMERS[0];
		} catch {
			return CUSTOMERS[0];
		}
	});
	const [topups, setTopups] = useState(FALLBACK_TOPUPS);
	// Identity is server-issued: load the signed tokens once, before any
	// billing query can fire, then render.
	const [identityReady, setIdentityReady] = useState(false);

	useEffect(() => {
		try {
			window.localStorage.setItem(CUSTOMER_STORAGE_KEY, customerId);
		} catch {
			// Private mode: the switcher just forgets, which is the old behaviour.
		}
	}, [customerId]);

	useEffect(() => {
		loadCustomerTokens()
			.then((ids) => {
				if (ids.length) {
					setCustomers(ids);
					setCustomerId((current) => (ids.includes(current) ? current : ids[0]));
				}
				setIdentityReady(true);
			})
			.catch(() => setIdentityReady(true)); // render anyway; API calls will 401 loudly
	}, []);

	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((data) => {
				if (Array.isArray(data?.topups) && data.topups.length) {
					setTopups(data.topups);
				}
			})
			.catch(() => {}); // keep the fallback packs
	}, []);

	if (!identityReady) return null;

	return (
		// Keyed per customer: identity is a server-signed token presented in
		// the x-meterpal-customer header; remounting refreshes every billing query.
		<AutumnProvider
			key={customerId}
			backendUrl=""
			headers={authHeaders(customerId)}
		>
			<Dashboard
				customerId={customerId}
				customers={customers}
				topups={topups}
				onCustomerChange={setCustomerId}
			/>
		</AutumnProvider>
	);
}

/**
 * The customer's wallet, as the billing server reports it.
 *
 * `balance` is the SETTLED figure, not the raw one: a metered call reserves
 * its worst-case price while it runs, and that reservation is a real
 * deduction on the balance row until the call settles.  Read raw, the wallet
 * leaps down when a call starts and springs back when it ends.  The server
 * adds the reservations back, so this number only ever steps down by a
 * charge that actually happened.
 */
type Wallet = {
	/** What the customer has spent down to. The number on screen. */
	balance: number | null;
	/** Everything granted, for the progress bar's denominator. */
	granted: number | null;
	/** Reserved by calls in flight right now. */
	held: number;
	monthSpend: number | null;
	mandateEnabled: boolean;
};

const EMPTY_WALLET: Wallet = {
	balance: null,
	granted: null,
	held: 0,
	monthSpend: null,
	mandateEnabled: false,
};

function useWalletSummary(customerId: string) {
	const [wallet, setWallet] = useState<Wallet | null>(null);
	// When the last authoritative charge was applied, and which poll is the
	// newest.  Both exist to stop a STALE read from moving the number
	// backwards: a poll issued before a charge lands carries the pre-charge
	// balance, and applying it would make the wallet jump back up — the
	// exact flicker this hook exists to prevent.
	const appliedAt = useRef(0);
	const latest = useRef(0);

	const load = useCallback(async () => {
		const mine = ++latest.current;
		const startedAt = Date.now();
		try {
			const res = await fetch("/api/wallet", {
				headers: authHeaders(customerId),
			});
			if (!res.ok) return;
			const data = await res.json();
			// Superseded by a newer poll, or issued before the charge we
			// already showed: either way it is stale.  Drop it.
			if (mine !== latest.current) return;
			if (startedAt < appliedAt.current) return;
			setWallet({
				balance: typeof data?.settled === "number" ? data.settled : null,
				granted: typeof data?.granted === "number" ? data.granted : null,
				held: typeof data?.held === "number" ? data.held : 0,
				monthSpend:
					typeof data?.month_spend === "number" ? data.month_spend : null,
				mandateEnabled: data?.mandate_enabled === true,
			});
		} catch {
			/* keep the last known value */
		}
	}, [customerId]);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), 2500);
		return () => clearInterval(timer);
	}, [load]);

	/**
	 * Apply the charge the call just reported.
	 *
	 * This is the authoritative number — the server read it after the debit
	 * landed — so the wallet moves the instant the call finishes instead of
	 * waiting for the next poll.  The poll that follows refreshes the rest.
	 */
	const applyCharge = useCallback(
		(balanceAfter: number | null | undefined) => {
			if (typeof balanceAfter !== "number" || !Number.isFinite(balanceAfter)) {
				return;
			}
			// A charge can never INCREASE the wallet.  If a server ever hands
			// back a figure above what we are showing, it is either stale or
			// it includes a reservation that will be refunded — applying it
			// would make the number jump up and then back down.  Ignore it and
			// let the authoritative poll decide.  Top-ups do not go through
			// here; they arrive as a fresh poll with a new, higher balance.
			appliedAt.current = Date.now();
			setWallet((current) =>
				current &&
				typeof current.balance === "number" &&
				balanceAfter <= current.balance + 1e-6
					? { ...current, balance: balanceAfter }
					: current,
			);
			void load();
		},
		[load],
	);

	return { wallet, reload: load, applyCharge };
}

/**
 * The header's credits pill.
 *
 * `pending` is the credits accruing in the call running right now — shown
 * as a separate, clearly-labelled figure rather than subtracted from the
 * balance, because it is an estimate until the call settles.  The balance
 * itself is always the server's settled number.
 */
function WalletPill({
	balance,
	pending,
}: {
	balance: number | null;
	pending: number;
}) {
	const low = typeof balance === "number" && balance < 1;

	return (
		<div
			className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3.5 text-sm font-semibold text-amber-200"
			data-testid="wallet-pill"
			title="The customer's credit wallet — every call debits it"
		>
			<IconWallet size={15} />
			<span className="tabular-nums">
				{balance === null ? "—" : balance.toFixed(2)}
			</span>
			{pending > 0 ? (
				<span
					className="text-[10px] font-normal text-amber-300/90 tabular-nums"
					data-testid="wallet-pending"
				>
					−{pending.toFixed(4)}
				</span>
			) : (
				<span className="text-[10px] font-normal text-amber-200/70">
					credits
				</span>
			)}
			{(low || pending > 0) && (
				<span className="size-1.5 animate-pulse rounded-full bg-rose-400" />
			)}
		</div>
	);
}

/**
 * The plan the customer is on, always on screen.  The wallet pill says how
 * many credits are left; this says what they are paying for — without it the
 * plan switch is invisible and a successful upgrade looks like nothing
 * happened.
 */
function CurrentPlanPill() {
	const { planId, name, isLoading } = useCurrentPlan();

	if (!planId && isLoading) {
		return (
			<div
				className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3.5 text-xs text-muted-foreground"
				data-testid="current-plan-pill"
			>
				<IconRosetteDiscountCheck size={15} />
				…
			</div>
		);
	}

	return (
		<div
			className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/10 px-3.5 text-sm font-semibold text-sky-200"
			data-testid="current-plan-pill"
			title="The plan this customer is currently on"
		>
			<IconRosetteDiscountCheck size={15} />
			{name ?? planId ?? "No plan"}
			<span className="text-[10px] font-normal text-sky-200/70">plan</span>
		</div>
	);
}

function Dashboard({
	customerId,
	customers,
	topups,
	onCustomerChange,
}: {
	customerId: string;
	customers: string[];
	topups: TopUp[];
	onCustomerChange: (id: string) => void;
}) {
	const setCustomerId = onCustomerChange;
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
	// Set only in the approval popup, so it renders a small "done" screen
	// instead of a second copy of the dashboard.
	const [popupReturn, setPopupReturn] = useState<PaymentReturn | null>(null);
	// True while an agent-initiated PayPal approval is in flight.  Drives the
	// capture poll below, which is what makes the loop complete even when
	// PayPal's browser redirect misbehaves.
	const [awaitingApproval, setAwaitingApproval] = useState(false);
	const [paypalClientId, setPaypalClientId] = useState<string | null>(null);
	// The sandbox buyer that approves payments, when the operator names one.
	const [paypalBuyer, setPaypalBuyer] = useState<string | null>(null);
	const [models, setModels] = useState<ServedModel[]>([]);
	const [modelId, setModelId] = useState("custom/demo-gpt");
	const [chatTab, setChatTab] = useState<"assistant" | "sales">("assistant");
	const [railTab, setRailTab] = useState<RailTab>("wallet");
	const { wallet, reload: reloadWallet, applyCharge } =
		useWalletSummary(customerId);
	// Credits accruing in the call running right now, from the merchant's own
	// published rates.  An ESTIMATE until the call settles, which is why it
	// is shown beside the balance rather than subtracted from it.
	const [pending, setPending] = useState(0);
	// Whether the merchant turned streaming on (dashboard -> Settings -> Chat).
	// The server decides per request; this is only what the UI reports.
	const [streaming, setStreaming] = useState(true);
	// Polled here (not in Offers) so the tab badges while closed.
	const { proposals, reload: reloadOffers } = useOffers(customerId);
	const pendingOffers = proposals.filter(
		(p) => p.status === "pending_customer",
	).length;

	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((data) => setStreaming(data?.streaming !== false))
			.catch(() => {});
	}, []);

	useEffect(() => {
		fetch("/api/paypal/config")
			.then((r) => r.json())
			.then((d) => {
				setPaypalClientId(d?.clientId ?? null);
				setPaypalBuyer(d?.buyer ?? null);
			})
			.catch(() => {});
	}, []);

	// Recover a payment the buyer approved while this tab was closed — or
	// before the capture poll existed.  An APPROVED-but-uncaptured order has
	// moved no money, so one check on mount can still fund the wallet.
	useEffect(() => {
		let alive = true;
		fetch("/api/paypal/poll", { headers: authHeaders(customerId) })
			.then((r) => r.json())
			.then((data) => {
				if (!alive || data?.status !== "captured") return;
				setPaymentNotice(
					`✅ Payment captured — ${data.credits ?? 0} credits added to your wallet.`,
				);
				window.dispatchEvent(new Event("agent-checkout-changed"));
				window.dispatchEvent(new Event("offers-changed"));
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [customerId]);

	// The models this merchant serves, with their prices.  This is the
	// merchant's own price sheet -- the app shows exactly what it may call
	// and what it charges.
	useEffect(() => {
		fetch("/api/models")
			.then((r) => r.json())
			.then((d) => {
				const served: ServedModel[] = d?.models ?? [];
				setModels(served);
				const served_ = served.filter((m) => m.enabled);
				// The demo narrative prices off demo-gpt; prefer it when served.
				const preferred =
					served_.find((m) => m.model_id === "custom/demo-gpt") ?? served_[0];
				if (preferred) setModelId(preferred.model_id);
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
		const payload: PaymentReturn = {
			payment,
			credits: params.get("credits"),
			subscription: params.get("subscription"),
			reason: params.get("reason"),
		};
		window.history.replaceState({}, "", window.location.pathname);

		// When the agent auto-opened the approval popup, THIS document is that
		// popup.  Send the result back to the chat window and get out of the
		// way instead of rendering a second dashboard inside the popup.
		if (isApprovalPopupWindow()) {
			try {
				sessionStorage.removeItem(APPROVAL_POPUP_MARKER);
			} catch {
				/* storage unavailable */
			}
			publishPaymentReturn(payload);
			setPopupReturn(payload);
			// window.close() only works on script-opened windows.  If PayPal's
			// redirect chain broke that link, the clean "done" screen below
			// is still what the buyer sees.
			const timer = window.setTimeout(() => window.close(), 700);
			return () => window.clearTimeout(timer);
		}
		setPaymentNotice(paymentNoticeFor(payload));
	}, []);

	useEffect(() => {
		// The chat window learns the outcome without a refresh: refresh the
		// durable checkout banner and the offers rail, and show the notice.
		const handle = (payload: PaymentReturn) => {
			clearApprovalWindow();
			setAwaitingApproval(false);
			setPaymentNotice(paymentNoticeFor(payload));
			window.dispatchEvent(new Event("agent-checkout-changed"));
			window.dispatchEvent(new Event("offers-changed"));
		};
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) return;
			if (event.data?.type !== PAYMENT_RETURN_CHANNEL) return;
			handle(event.data as PaymentReturn);
		};
		window.addEventListener("message", onMessage);
		let channel: BroadcastChannel | null = null;
		try {
			channel = new BroadcastChannel(PAYMENT_RETURN_CHANNEL);
			channel.onmessage = (event) => handle(event.data as PaymentReturn);
		} catch {
			/* BroadcastChannel unsupported — postMessage still covers it */
		}
		return () => {
			window.removeEventListener("message", onMessage);
			channel?.close();
		};
	}, []);

	// Safety net for the redirect flow.  PayPal can bounce a popup back onto
	// its own payment page instead of hitting /paypal/return (orders created
	// without a return_url, login round trips, popup quirks).  /paypal/poll
	// captures an APPROVED order and grants the credits server-side, so the
	// loop completes on approval alone — the browser redirect is an
	// optimisation, never the only path to a funded wallet.
	useEffect(() => {
		if (!awaitingApproval) return;
		let alive = true;
		const deadline = Date.now() + 10 * 60 * 1000;
		const tick = async () => {
			if (!alive) return;
			if (Date.now() > deadline) {
				setAwaitingApproval(false);
				return;
			}
			try {
				const res = await fetch("/api/paypal/poll", {
					headers: authHeaders(customerId),
				});
				// A refusal (429) or an upstream fault is not an answer. Only a
				// 2xx may be read as "still pending" or "captured" -- reading a
				// rate-limit body as `status: undefined` looked the same as
				// "settled" and ended the watch early.
				if (!res.ok) return;
				const data = await res.json();
				// "none" is normal while the buyer is still on PayPal (sandbox
				// orders sit in PAYER_ACTION_REQUIRED), so keep polling.
				if (!alive || data?.status !== "captured") return;
				setAwaitingApproval(false);
				setPaymentNotice(
					`✅ Payment captured — ${data.credits ?? 0} credits added to your wallet. Send your message again.`,
				);
				window.dispatchEvent(new Event("agent-checkout-changed"));
				window.dispatchEvent(new Event("offers-changed"));
				// The money is settled; do not leave the buyer staring at a
				// PayPal page that has looped back on itself.
				closeApprovalWindow(activeApprovalWindow);
			} catch {
				/* transient — keep polling */
			}
		};
		tick();
		const timer = window.setInterval(tick, 2000);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, [awaitingApproval, customerId]);

	// The price sheet entry for the model on screen — what the live meter
	// prices against.
	const model = models.find((m) => m.model_id === modelId);

	async function send(prompt: string) {
		if (!prompt.trim() || busy) return;
		const assistantId = crypto.randomUUID();
		setMessages((m) => [
			...m,
			{ role: "user", content: prompt },
			// The reply's slot exists before the first token does, so text can
			// be written into it as it arrives instead of the thread holding a
			// "thinking" placeholder that swaps for a wall of text at the end.
			{ role: "assistant", content: "", id: assistantId, streaming: true },
		]);
		setInput("");
		setBusy(true);
		setPending(0);

		const patch = (next: Partial<Message>) =>
			setMessages((m) =>
				m.map((msg) => (msg.id === assistantId ? { ...msg, ...next } : msg)),
			);

		// Pre-open the approval window on the click gesture: by the time the
		// agent's 402 comes back, browser popup blockers would refuse it.
		const approvalWindow =
			wallet?.mandateEnabled && wallet.balance !== null && wallet.balance < 1
				? prepareApprovalWindow()
				: null;
		let handedOff = false;

		try {
			const res = await fetch("/api/chat", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...authHeaders(customerId),
				},
				// The server decides how to answer: a merchant who turned
				// streaming off gets one JSON payload back, whoever asked for
				// what.  The content type says which happened.
				body: JSON.stringify({ prompt, model: modelId, stream: true }),
			});

			if (res.status === 402) {
				// Admission control refused the call before the model ran — the
				// paywall card carries the buyer agent's decision with it.
				const data = await res.json().catch(() => ({}));
				// Surface the decision beyond the chat thread: an initiated
				// checkout feeds the durable banner, a drafted top-up badges the
				// Offers tab.
				if (data?.agent_action === "initiated") {
					window.dispatchEvent(new Event("agent-checkout-changed"));
					// The agent already created the PayPal order server-side.
					// Transition to PayPal's login/approval automatically —
					// the human gate is PayPal consent, not an in-app button.
					if (data?.checkout?.url) {
						handedOff = openApproval(data.checkout.url, approvalWindow);
						// Watch the order regardless of how the buyer reaches
						// PayPal: the auto popup, or the manual "Reopen" link
						// when a popup blocker intervenes.  Approval must
						// always settle the wallet.
						setAwaitingApproval(true);
						setPaymentNotice(
							handedOff
								? "Your agent opened PayPal automatically — log in there to approve the payment."
								: "Your agent opened a PayPal checkout — use the Approve in PayPal link on the paywall card (popup blocked).",
						);
					}
				} else if (data?.agent_action === "approval_required") {
					window.dispatchEvent(new Event("offers-changed"));
				}
				patch({
					streaming: false,
					content:
						data?.agent_action === "initiated"
							? "Your agent stepped in."
							: data?.agent_action === "approval_required"
								? "Your agent drafted a top-up for your approval."
								: data?.agent_action === "denied"
									? "Your agent stood down."
									: "Call refused.",
					paywall: data,
				});
				return;
			}

			const isStream = (res.headers.get("content-type") ?? "").includes(
				"text/event-stream",
			);

			if (!isStream) {
				const data = await res.json();
				patch({
					streaming: false,
					content: data?.choices?.[0]?.message?.content ?? "(empty reply)",
					charged: data?.meterpal?.credits_charged ?? undefined,
					tokens: data?.meterpal
						? {
								input: data.meterpal.input_tokens ?? 0,
								output: data.meterpal.output_tokens ?? 0,
								cacheRead: data.meterpal.cache_read_tokens ?? 0,
								reasoning: data.meterpal.reasoning_tokens ?? 0,
							}
						: undefined,
				});
				setPending(0);
				// The charge already landed server-side; move the wallet now
				// rather than waiting for the next poll to notice.
				applyCharge(data?.meterpal?.balance_after);
				return;
			}

			const reader = res.body?.getReader();
			if (!reader) throw new Error("the response had no body");

			const decoder = new TextDecoder();
			let buffer = "";
			let text = "";
			let accrued = 0;
			let painted = 0;
			// Set once the charge (or a failure) has been handled, so the final
			// repaint cannot undo it.
			let settled = false;

			// Repaint at most every ~50ms.  A long reply arrives as hundreds of
			// chunks, and re-rendering the thread on every one is wasted work
			// that makes the text stutter instead of flowing.
			const paint = (force = false) => {
				if (settled) return;
				const now = Date.now();
				if (!force && now - painted < 50) return;
				painted = now;
				patch({
					content: text,
					live: { tokens: Math.round(text.length / 4), credits: accrued },
				});
				setPending(accrued);
			};

			const handle = (payload: any) => {
				if (typeof payload?.delta === "string") {
					text += payload.delta;
					accrued = estimateCredits(model, prompt.length, text.length);
					paint();
					return;
				}
				if (payload?.meterpal) {
					// The authoritative charge for this call, and the balance the
					// server read right after debiting it.
					const m = payload.meterpal;
					settled = true;
					patch({
						streaming: false,
						content: text,
						charged: m?.credits_charged ?? undefined,
						tokens: {
							input: m?.input_tokens ?? 0,
							output: m?.output_tokens ?? 0,
							cacheRead: m?.cache_read_tokens ?? 0,
							reasoning: m?.reasoning_tokens ?? 0,
						},
						live: undefined,
					});
					setPending(0);
					applyCharge(m?.balance_after);
					return;
				}
				if (payload?.error) {
					settled = true;
					patch({
						streaming: false,
						content: `${text}${text ? "\n\n" : ""}⚠️ ${payload.error}`,
						live: undefined,
					});
					setPending(0);
				}
			};

			// A stream can end without a `meterpal` block — no settled usage
			// event, or an upstream that stopped early.  Never leave the caret
			// blinking or a phantom estimate on the wallet: stop the live
			// meter and let the authoritative poll set the number.
			const finish = () => {
				if (settled) return;
				settled = true;
				patch({ streaming: false, content: text, live: undefined });
				setPending(0);
				void reloadWallet();
			};

			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split("\n\n");
				buffer = parts.pop() ?? "";
				for (const part of parts) {
					const line = part
						.split("\n")
						.find((entry) => entry.startsWith("data:"));
					if (!line) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					if (raw === "[DONE]") {
						paint(true);
						finish();
						return;
					}
					try {
						handle(JSON.parse(raw));
					} catch {
						// A frame we do not understand is not a reason to stop.
					}
				}
			}
			paint(true);
			finish();
		} catch (err) {
			patch({
				streaming: false,
				content: `⚠️ request failed: ${String(err)}`,
				live: undefined,
			});
			setPending(0);
			void reloadWallet();
		} finally {
			if (!handedOff) closeApprovalWindow(approvalWindow);
			setBusy(false);
		}
	}

	// The approval popup's return landing.  It has already handed the result
	// to the chat window, so it never renders the dashboard.
	if (popupReturn) {
		return (
			<div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
				<p className="text-sm font-medium text-foreground">
					{paymentNoticeFor(popupReturn)}
				</p>
				<p className="max-w-sm text-xs text-muted-foreground">
					Your chat window has been updated with the new balance. You can close
					this tab and carry on there.
				</p>
				<button
					type="button"
					className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
					onClick={() => window.close()}
				>
					Close this tab
				</button>
			</div>
		);
	}

	return (
		<div className="mx-auto flex h-screen max-w-7xl flex-col px-6 pb-6 pt-5">
			{/* Wraps rather than overflowing: the header carries the credits pill
				and the current-plan pill, and a narrow window must not push them
				off-screen. */}
			<header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 py-1">
				<div className="flex min-w-0 items-center">
					<img
						src={meterpalWordmark}
						alt="MeterPal"
						className="h-8 w-auto shrink-0"
					/>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-2.5">
					<select
						value={customerId}
						onChange={(e) => {
							setCustomerId(e.target.value);
							setMessages([]);
						}}
						className="h-9 min-w-0 max-w-[160px] shrink rounded-full border border-border bg-muted/60 px-3.5 text-xs outline-none"
						data-testid="customer-switcher"
						title="The end user being billed"
					>
						{customers.map((c) => (
							<option key={c} value={c}>
								{c}
							</option>
						))}
					</select>
					<select
						value={modelId}
						onChange={(e) => setModelId(e.target.value)}
						className="h-9 min-w-0 max-w-[220px] shrink rounded-full border border-border bg-muted/60 px-3.5 text-xs outline-none"
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
					<WalletPill balance={wallet?.balance ?? null} pending={pending} />
					<CurrentPlanPill />
				</div>
			</header>

			{/* collapses to nothing when no banners are showing */}
			<div className="empty:hidden flex shrink-0 flex-col gap-3 pt-4">
				<AgentCheckoutNotice customerId={customerId} onNotice={setPaymentNotice} />
				{paymentNotice && (
					<div
						role="status"
						data-testid="payment-notice"
						className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-900 dark:text-emerald-100"
					>
						{paymentNotice}
					</div>
				)}
				<SpendAlerts customerId={customerId} />
			</div>

			<main className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_400px]">
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
											key={m.id ?? i}
											className="mp-bubble-user"
											data-testid="chat-user-msg"
										>
											{m.content}
										</div>
									) : (
										<div key={m.id ?? i} className="mp-msg-agent">
											<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
												<IconBolt size={15} />
											</span>
											<div className="min-w-0 flex-1 space-y-1.5">
												<p className="text-[11px] font-semibold text-muted-foreground">
													Assistant
												</p>
												<div
													className="whitespace-pre-wrap text-sm"
													data-testid={
														m.streaming ? "chat-streaming-msg" : undefined
													}
												>
													{m.content}
													{m.streaming && (
														<span
															className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-primary align-middle"
															aria-hidden
														/>
													)}
												</div>
												{m.streaming && !m.content && (
													<p className="text-xs text-muted-foreground">
														waiting for the first token…
													</p>
												)}
												{/* The live meter: what this reply has accrued so
												    far, at the merchant's own rates. It is
												    replaced by the exact charge below the moment
												    the call settles. */}
												{m.streaming && m.live && (
													<div
														className="flex flex-wrap items-center gap-1.5"
														data-testid="chat-live-meter"
													>
														<span className="mp-chip !text-sky-200">
															<span className="size-1.5 animate-pulse rounded-full bg-sky-400" />
															metering · {m.live.tokens.toLocaleString()} tokens
														</span>
														<span className="mp-chip !text-amber-200 tabular-nums">
															<IconCoins size={11} className="text-amber-300" />≈
															{m.live.credits.toFixed(4)} credits
														</span>
													</div>
												)}
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
															<span
																className="mp-chip"
																title="Prompt and completion tokens as the provider counted them — the same counts the charge was computed from."
															>
																{m.tokens.input.toLocaleString()} in /{" "}
																{m.tokens.output.toLocaleString()} out
															</span>
														)}
														{/* Cached input and reasoning are inside the in/out
														    totals above, and priced through their own pool
														    (cache reads at the input rate, reasoning at the
														    output rate).  Naming them keeps the charge
														    checkable against the rate sheet instead of
														    looking like it was rounded up. */}
														{((m.tokens?.cacheRead ?? 0) > 0 ||
															(m.tokens?.reasoning ?? 0) > 0) && (
															<span
																className="mp-chip"
																title="Already included in the in/out totals: cached input is billed at the input rate, reasoning at the output rate."
															>
																{[
																	(m.tokens?.cacheRead ?? 0) > 0 &&
																		`${(m.tokens?.cacheRead ?? 0).toLocaleString()} cached`,
																	(m.tokens?.reasoning ?? 0) > 0 &&
																		`${(m.tokens?.reasoning ?? 0).toLocaleString()} reasoning`,
																]
																	.filter(Boolean)
																	.join(" · ")}
															</span>
														)}
													</div>
												)}
												{m.paywall && (
													<PaywallCard
														data={m.paywall}
														buyer={paypalBuyer}
														onTopUp={() =>
															window.dispatchEvent(new Event("open-topup-modal"))
														}
													/>
												)}
											</div>
										</div>
									),
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
								<p className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
									<span>
										Each send is admitted against the wallet, then metered per
										token from the merchant's price sheet.
									</span>
									<span
										className="mp-chip !text-sky-300"
										data-testid="streaming-state"
										title="Set by the merchant in the dashboard: Settings → Chat"
									>
										{streaming ? "streaming on" : "streaming off"}
									</span>
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
							{id === "offers" && pendingOffers > 0 && (
								<span
									data-testid="offers-badge"
									className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-amber-950"
								>
									{pendingOffers}
								</span>
							)}
						</button>
					))}
					</div>
					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
						{railTab === "wallet" && (
							<>
								<section className="mp-card p-4">
									<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
										<IconWallet size={13} className="text-amber-300" />
										Credits
									</p>
									<div className="mt-1 flex items-end justify-between">
										<p
											className="text-4xl font-bold tracking-tight tabular-nums transition-all duration-300"
											data-testid="wallet-balance"
										>
											{wallet?.balance === null || wallet?.balance === undefined
												? "—"
												: wallet.balance.toFixed(2)}
										</p>
										{wallet?.monthSpend !== null &&
											wallet?.monthSpend !== undefined && (
												<p className="pb-1 text-xs text-muted-foreground">
													${wallet.monthSpend.toFixed(2)} spent this month
												</p>
											)}
									</div>
									{/* Real-time drain.  This is the ESTIMATED balance while
									    tokens are arriving, priced at the merchant's own
									    rate sheet.  It sits beside the authoritative figure
									    rather than replacing it: the exact charge is only
									    known when the call settles, and the big number must
									    never show a value that later moves back up. */}
									{pending > 0 && (
										<div
											className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums"
											data-testid="wallet-pending-rail"
										>
											<span className="flex items-center gap-1.5 text-amber-300/90">
												<span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
												live ≈
												{typeof wallet?.balance === "number"
													? Math.max(0, wallet.balance - pending).toFixed(4)
													: "—"}
											</span>
											<span className="text-muted-foreground">
												−{pending.toFixed(4)} metering…
											</span>
										</div>
									)}
									{wallet?.granted ? (
										<div className="mt-2 h-1.5 rounded-full bg-muted">
											<div
												className="h-1.5 rounded-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-300"
												style={{
													width: `${Math.min(100, Math.max(2, ((wallet.balance ?? 0) / wallet.granted) * 100))}%`,
												}}
											/>
										</div>
									) : null}
									<button
										type="button"
										onClick={() =>
											window.dispatchEvent(new Event("open-topup-modal"))
										}
										className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-400 px-3 py-2.5 text-sm font-semibold text-amber-950 transition hover:bg-amber-300"
										data-testid="open-topup"
									>
										<IconBrandPaypal size={16} />
										Buy credits with PayPal
									</button>
								</section>
								<TopUpModal
										productIds={topups.map((t) => t.id)}
										labels={topups.map((t) => t.label)}
										prices={topups.map((t) => t.price)}
										inPageCheckout={
											paypalClientId
												? {
														clientId: paypalClientId,
														capture: async (orderId: string) => {
															const res = await fetch(
																`/api/paypal/capture/${encodeURIComponent(orderId)}`,
																{
																	method: "POST",
																	headers: authHeaders(customerId),
																},
															);
															return res.json();
														},
													}
												: undefined
										}
										pollFinalize={async () => {
											// The poll route is customer-scoped: without the
											// signed token it answers 401 and the in-page
											// checkout could never settle its own capture.
											const res = await fetch("/api/paypal/poll", {
												headers: authHeaders(customerId),
											});
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
								<Offers
									customerId={customerId}
									proposals={proposals}
									reload={reloadOffers}
									onNotice={setPaymentNotice}
								/>
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
