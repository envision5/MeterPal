// demo-app/src/components/SalesChat.tsx
//
// The customer-facing side of the sales-rep agent.  Messages go to the
// merchant's app server, which proxies the billing server's agent; the
// agent's ground truth is the usage ledger, so every number it quotes is
// arithmetic over real calls.

import { useEffect, useRef, useState } from "react";

type SalesMessage = { role: "customer" | "agent"; content: string };

export default function SalesChat({ customerId }: { customerId: string }) {
	const [messages, setMessages] = useState<SalesMessage[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setMessages([]);
		setInput("");
	}, [customerId]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages, busy]);

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
					"x-meterpal-customer": customerId,
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
		<div className="flex h-full flex-col" data-testid="sales-chat">
			<div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
				{messages.length === 0 && (
					<p className="text-sm text-muted-foreground">
						Negotiate your own package. The agent can see your real usage —
						tell it what you need (e.g. “I burn about 2 credits a day and
						want a better rate on 100/month”).
					</p>
				)}
				{messages.map((m, i) => (
					<div
						key={i}
						className={[
							"rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
							m.role === "customer"
								? "ml-auto max-w-[80%] bg-primary text-primary-foreground"
								: "max-w-[90%] border border-border bg-muted",
						].join(" ")}
						data-testid={m.role === "agent" ? "sales-reply" : undefined}
					>
						{m.content}
					</div>
				))}
				{busy && <p className="text-xs text-muted-foreground">negotiating…</p>}
			</div>
			<form
				className="flex gap-2 border-t border-border p-3"
				onSubmit={(e) => {
					e.preventDefault();
					send();
				}}
			>
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder="Tell the sales agent what you need…"
					className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
					data-testid="sales-input"
				/>
				<button
					type="submit"
					disabled={busy}
					className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
					data-testid="sales-send"
				>
					Send
				</button>
			</form>
		</div>
	);
}
