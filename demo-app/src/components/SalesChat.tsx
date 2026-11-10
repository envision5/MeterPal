// demo-app/src/components/SalesChat.tsx
//
// The customer-facing side of the sales-rep agent.  The agent's ground truth
// is the usage ledger — every number it quotes is arithmetic over real calls,
// and a settled negotiation renders as a package card with its approval trail.

import {
	IconClock,
	IconCoins,
	IconDatabase,
	IconGift,
	IconRobot,
	IconSend,
	IconSparkles,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "../customerIdentity";

type SalesMessage = { role: "customer" | "agent"; content: string };

type DraftProposal = {
	id: string;
	payload: {
		name: string;
		credits: number;
		price_usd: number;
		reasoning: string;
	};
};

export default function SalesChat({ customerId }: { customerId: string }) {
	const [messages, setMessages] = useState<SalesMessage[]>([]);
	const [draft, setDraft] = useState<DraftProposal | null>(null);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setMessages([]);
		setDraft(null);
		setInput("");
	}, [customerId]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages, busy, draft]);

	async function send() {
		const message = input.trim();
		if (!message || busy) return;
		setInput("");
		setMessages((m) => [...m, { role: "customer", content: message }]);
		setBusy(true);
		try {
			const res = await fetch("/api/sales/chat", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...authHeaders(customerId),
				},
				body: JSON.stringify({
					message,
					history: messages.slice(-30),
				}),
			});
			const data = await res.json().catch(() => ({}));
			setMessages((m) => [
				...m,
				{
					role: "agent",
					content:
						data?.reply ??
						"(the sales agent could not reply — try again in a moment)",
				},
			]);
			if (data?.proposal) {
				setDraft(data.proposal);
				// A draft went to the merchant — refresh offers on the next poll.
				window.dispatchEvent(new Event("offers-changed"));
			}
		} catch {
			setMessages((m) => [
				...m,
				{ role: "agent", content: "⚠️ could not reach the sales agent." },
			]);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="sales-chat">
			<div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
				{messages.length === 0 && !draft && (
					<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
						<span className="flex size-12 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-300">
							<IconSparkles size={26} />
						</span>
						<p className="text-sm font-medium">
							Negotiate your own package with the merchant's sales agent
						</p>
						<span className="mp-chip">
							<IconDatabase size={12} className="text-violet-300" />
							grounded in your real usage ledger
						</span>
						<p className="max-w-md text-xs text-muted-foreground">
							Tell it what you need — “I burn about 0.36 credits a call and want
							a better rate on volume.” Terms settle with the agent, the
							merchant approves, PayPal takes it from there.
						</p>
					</div>
				)}
				{messages.map((m, i) =>
					m.role === "customer" ? (
						<div
							key={i}
							className="mp-bubble-user"
							data-testid="sales-customer-msg"
						>
							{m.content}
						</div>
					) : (
						<div key={i} className="mp-msg-agent" data-testid="sales-reply">
							<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
								<IconRobot size={15} />
							</span>
							<div className="min-w-0 flex-1">
								<p className="mb-1 text-[11px] font-semibold text-violet-300">
									Sales agent
									<span className="ml-1.5 font-normal text-muted-foreground">
										· grounded in your ledger
									</span>
								</p>
								<div className="whitespace-pre-wrap text-sm">{m.content}</div>
							</div>
						</div>
					),
				)}
				{draft && (
					<div
						className="ml-10 rounded-2xl border border-violet-500/40 bg-violet-500/[0.07] p-4"
						data-testid="sales-draft"
					>
						<div className="flex items-center gap-2">
							<span className="flex size-8 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
								<IconGift size={17} />
							</span>
							<div>
								<p className="text-sm font-semibold">{draft.payload.name}</p>
								<p className="flex items-center gap-1 text-xs text-amber-200">
									<IconCoins size={12} />
									{draft.payload.credits} credits · $
									{draft.payload.price_usd.toFixed(2)}
								</p>
							</div>
							<span className="ml-auto inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-200">
								<IconClock size={12} />
								merchant approval pending
							</span>
						</div>
						<p className="mt-2 text-xs text-muted-foreground">
							{draft.payload.reasoning}
						</p>
						<p className="mt-2 inline-flex items-center gap-1 text-[11px] text-violet-300">
							<IconSparkles size={12} />
							Watch the <strong className="mx-1">Offers</strong> rail — once the
							merchant approves, the package appears there for you to buy.
						</p>
					</div>
				)}
				{busy && (
					<div className="mp-msg-agent">
						<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
							<IconRobot size={15} />
						</span>
						<p className="text-xs text-muted-foreground">negotiating…</p>
					</div>
				)}
			</div>
			<form
				className="px-4 pb-4"
				onSubmit={(e) => {
					e.preventDefault();
					send();
				}}
			>
				<div className="mp-composer">
					<input
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder="Tell the sales agent what you need…"
						className="mp-composer-input"
						data-testid="sales-input"
					/>
					<button
						type="submit"
						disabled={busy}
						className="flex size-9 items-center justify-center rounded-xl bg-violet-500 text-white transition hover:bg-violet-400 disabled:opacity-40"
						data-testid="sales-send"
					>
						<IconSend size={17} />
					</button>
				</div>
				<p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
					The agent can see your balance, burn rate, and runway — never invented
					numbers.
				</p>
			</form>
		</div>
	);
}
