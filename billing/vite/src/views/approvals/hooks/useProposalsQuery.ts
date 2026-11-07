// billing/vite/src/views/approvals/hooks/useProposalsQuery.ts
//
// The Approvals inbox data: agent proposals (list + decisions) and the
// unusual-spend flags, following the standard query-hook pattern.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useQueryKeyFactory } from "@/hooks/common/useQueryKeyFactory";

export type AgentProposal = {
	id: string;
	kind: "custom_package" | "topup_authorization";
	status: string;
	customer_id: string;
	plan_id: string | null;
	payload: {
		name: string;
		credits: number;
		price_usd: number;
		reasoning: string;
		customer_needs?: string[];
		product_id?: string;
		projected_months?: number;
	};
	conversation: { role: "customer" | "agent"; content: string; at: number }[] | null;
	created_at: number;
	decided_at: string | null;
};

export type SpendAnomalyRow = {
	customer_id: string;
	flagged: boolean;
	reason: string | null;
	last24hSpend: number;
	baselineDaily: number;
};

export const useProposalsQuery = () => {
	const axiosInstance = useAxiosInstance();
	const buildKey = useQueryKeyFactory();
	const queryClient = useQueryClient();

	const proposalsQuery = useQuery({
		queryKey: buildKey(["agent-proposals"]),
		queryFn: async () => {
			const { data } = await axiosInstance.get("/sales-agent/proposals");
			return (data?.proposals ?? []) as AgentProposal[];
		},
		refetchInterval: 5000,
	});

	const anomaliesQuery = useQuery({
		queryKey: buildKey(["agent-anomalies"]),
		queryFn: async () => {
			const { data } = await axiosInstance.get("/sales-agent/anomalies");
			return (data?.anomalies ?? []) as SpendAnomalyRow[];
		},
		refetchInterval: 10000,
	});

	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: buildKey(["agent-proposals"]) });
	};

	const decideMutation = useMutation({
		mutationFn: async ({ proposalId, action }: { proposalId: string; action: "approve" | "reject" }) => {
			const { data } = await axiosInstance.post(
				`/sales-agent/proposals/${encodeURIComponent(proposalId)}/${action}`,
			);
			return data;
		},
		onSuccess: invalidate,
	});

	return { proposalsQuery, anomaliesQuery, decideMutation };
};
