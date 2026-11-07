// billing/vite/src/views/approvals/ApprovalsView.tsx
//
// The merchant's inbox for agent proposals.  The sales-rep agent drafts
// custom packages here for a one-click decision; approve mints the real plan
// (server-side) and the customer can then buy it.  Buyer-agent top-up
// authorizations and unusual-spend flags surface here too — the merchant sees
// everything its agents are doing on the ledger.

import { useState } from "react";
import { Badge, Button } from "@autumn/ui";
import { toast } from "sonner";
import { getBackendErr } from "@/utils/genUtils";
import {
	useProposalsQuery,
	type AgentProposal,
} from "./hooks/useProposalsQuery";

const STATUS_VARIANTS: Record<string, string> = {
	pending_merchant: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
	pending_customer: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
	approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
	purchased: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
	rejected: "bg-red-500/15 text-red-700 dark:text-red-400",
	declined: "bg-muted text-muted-foreground",
};

function ProposalCard({
	proposal,
	busy,
	onDecide,
}: {
	proposal: AgentProposal;
	busy: boolean;
	onDecide: (proposalId: string, action: "approve" | "reject") => void;
}) {
	const [showConversation, setShowConversation] = useState(false);
	const pending = proposal.status === "pending_merchant";

	return (
		<div
			className="rounded-xl border border-border p-4"
			data-testid="proposal-card"
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-2">
						<span className="font-semibold" data-testid="proposal-name">
							{proposal.payload.name}
						</span>
						<Badge
							className={`text-xs ${STATUS_VARIANTS[proposal.status] ?? "bg-muted"}`}
						>
							{proposal.status.replace("_", " ")}
						</Badge>
					</div>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{proposal.kind === "custom_package" ? "Sales agent" : "Buyer agent"}{" "}
						→ customer <span className="font-mono">{proposal.customer_id}</span>
						{" · "}
						{proposal.payload.credits} credits · $
						{proposal.payload.price_usd.toFixed(2)}
						{proposal.payload.projected_months
							? ` · ≈${proposal.payload.projected_months} months of runway`
							: ""}
					</p>
				</div>
				{pending && (
					<div className="flex shrink-0 gap-2">
						<Button
							variant="primary"
							disabled={busy}
							onClick={() => onDecide(proposal.id, "approve")}
							data-testid="proposal-approve"
						>
							Approve & mint plan
						</Button>
						<Button
							variant="secondary"
							disabled={busy}
							onClick={() => onDecide(proposal.id, "reject")}
							data-testid="proposal-reject"
						>
							Reject
						</Button>
					</div>
				)}
			</div>

			<p className="mt-2 text-sm text-muted-foreground">
				{proposal.payload.reasoning}
			</p>

			{proposal.payload.customer_needs?.length ? (
				<p className="mt-1 text-xs text-muted-foreground">
					Tracked needs: {proposal.payload.customer_needs.join(" · ")}
				</p>
			) : null}

			{proposal.conversation && proposal.conversation.length > 0 && (
				<>
					<button
						type="button"
						className="mt-2 text-xs text-muted-foreground underline hover:text-foreground"
						onClick={() => setShowConversation((v) => !v)}
					>
						{showConversation ? "Hide" : "Show"} negotiation (
						{proposal.conversation.length} messages)
					</button>
					{showConversation && (
						<div className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-lg bg-muted/50 p-3">
							{proposal.conversation.map((message, i) => (
								<div
									key={i}
									className={[
										"rounded-md px-2 py-1.5 text-xs whitespace-pre-wrap",
										message.role === "customer"
											? "ml-auto max-w-[80%] bg-primary/90 text-primary-foreground"
											: "max-w-[90%] border border-border bg-background",
									].join(" ")}
								>
									{message.content}
								</div>
							))}
						</div>
					)}
				</>
			)}

			{proposal.plan_id && (
				<p className="mt-2 text-xs text-muted-foreground">
					Minted plan: <span className="font-mono">{proposal.plan_id}</span>
				</p>
			)}
		</div>
	);
}

export default function ApprovalsView() {
	const { proposalsQuery, anomaliesQuery, decideMutation } = useProposalsQuery();

	const proposals = proposalsQuery.data ?? [];
	const anomalies = anomaliesQuery.data ?? [];
	const pending = proposals.filter((p) => p.status === "pending_merchant");
	const decided = proposals.filter((p) => p.status !== "pending_merchant");

	const onDecide = (proposalId: string, action: "approve" | "reject") => {
		decideMutation.mutate(
			{ proposalId, action },
			{
				onSuccess: () =>
					toast.success(
						action === "approve"
							? "Approved — the plan is minted and live in the customer's offers"
							: "Rejected — the customer will not see this draft",
					),
				onError: (error) => toast.error(getBackendErr(error, "Failed to decide")),
			},
		);
	};

	return (
		<div className="flex size-full flex-col gap-6 overflow-y-auto px-10 py-6">
			<div>
				<h1 className="text-xl font-semibold">Agent approvals</h1>
				<p className="text-sm text-muted-foreground">
					What your agents negotiated — nothing takes effect without a human
					click here.
				</p>
			</div>

			{anomalies.length > 0 && (
				<div
					className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4"
					data-testid="anomalies"
				>
					<h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
						Unusual spend ({anomalies.length})
					</h2>
					<ul className="mt-2 space-y-1 text-sm">
						{anomalies.map((a) => (
							<li key={a.customer_id}>
								<span className="font-mono">{a.customer_id}</span> — {a.reason}
							</li>
						))}
					</ul>
				</div>
			)}

			{proposalsQuery.isLoading ? (
				<p className="text-sm text-muted-foreground">Loading proposals…</p>
			) : pending.length === 0 ? (
				<p className="text-sm text-muted-foreground" data-testid="no-pending">
					No pending agent proposals. Negotiations from the sales agent land
					here for approval.
				</p>
			) : (
				<div className="space-y-3">
					{pending.map((proposal) => (
						<ProposalCard
							key={proposal.id}
							proposal={proposal}
							busy={decideMutation.isPending}
							onDecide={onDecide}
						/>
					))}
				</div>
			)}

			{decided.length > 0 && (
				<div>
					<h2 className="mb-2 text-sm font-semibold text-muted-foreground">
						Decided
					</h2>
					<div className="space-y-3 opacity-75">
						{decided.map((proposal) => (
							<ProposalCard
								key={proposal.id}
								proposal={proposal}
								busy={decideMutation.isPending}
								onDecide={onDecide}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
