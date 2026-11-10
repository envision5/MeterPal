// demo-app/src/useOffers.ts
//
// Shared poller for the customer's agent proposals — negotiated packages and
// buyer-agent top-up authorizations.  Lives at App level so the Offers tab
// can badge while closed, and so the PayPal-return finalize runs no matter
// which tab the user lands back on.

import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "./customerIdentity";

export type Proposal = {
	id: string;
	kind: "custom_package" | "topup_authorization";
	status: string;
	plan_id: string | null;
	payload: {
		name: string;
		credits: number;
		price_usd: number;
		reasoning: string;
		product_id?: string;
	};
};

export function useOffers(customerId: string) {
	const [proposals, setProposals] = useState<Proposal[]>([]);

	const reload = useCallback(async () => {
		try {
			const res = await fetch("/api/sales/offers", {
				headers: authHeaders(customerId),
			});
			const data = await res.json();
			setProposals(data?.proposals ?? []);
		} catch {
			/* keep the last list */
		}
	}, [customerId]);

	useEffect(() => {
		reload();
		const timer = setInterval(reload, 5000);
		window.addEventListener("offers-changed", reload);
		return () => {
			clearInterval(timer);
			window.removeEventListener("offers-changed", reload);
		};
	}, [reload]);

	// A proposal-backed purchase completes on the PayPal redirect back to the
	// app; mark it purchased no matter which tab the return lands on.
	useEffect(() => {
		const finalize = async () => {
			const raw = sessionStorage.getItem("agent-proposal-pending");
			if (!raw) return;
			sessionStorage.removeItem("agent-proposal-pending");
			const ids: string[] = JSON.parse(raw);
			for (const id of ids) {
				await fetch(`/api/sales/proposals/${encodeURIComponent(id)}/purchased`, {
					method: "POST",
					headers: authHeaders(customerId),
				}).catch(() => {});
			}
			reload();
		};
		finalize();
	}, [reload, customerId]);

	return { proposals, reload };
}
