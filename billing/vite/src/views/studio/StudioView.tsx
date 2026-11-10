// billing/vite/src/views/studio/StudioView.tsx
//
// The AG Studio surface.
//
// This is the merchant's usage dashboard, rebuilt as an embedded analytics
// studio instead of a fixed chart page. Three things make it more than a
// chart:
//
//   1. The data comes from the same analytics read path the rest of the
//      dashboard uses -- Tinybird in production, Postgres locally -- so the
//      studio and the classic Usage page can never disagree.
//
//   2. The assistant is AG Studio's Agent Framework. Ask it for a chart and
//      it builds one, using AG's own widget tools.
//
//   3. The agent is metered. Every turn runs through the billing server's
//      inference path, so the customer's wallet pays for it. When the wallet
//      is empty, the assistant is paywalled -- the same paywall the end user
//      meets in the product.

import { AgStudioAiModule, type AgReportState } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { ChartBarIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Button,
	PageContainer,
	PageHeader,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@autumn/ui";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { buildStudioAi } from "./studioAi";
import { buildStudioData } from "./studioData";
import { reportStorageKey, usageReport } from "./studioReport";
import type { MeterpalBlock } from "./studioAdapter";

type CustomerOption = {
	id: string;
	name: string | null;
	credits: number;
	events: number;
};

const readStoredReport = (key: string): AgReportState | null => {
	try {
		const raw = window.localStorage.getItem(key);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as AgReportState;
		return parsed?.pages?.length ? parsed : null;
	} catch {
		return null;
	}
};

export const StudioView = () => {
	const axios = useAxiosInstance();

	const [customers, setCustomers] = useState<CustomerOption[]>([]);
	const [customerId, setCustomerId] = useState<string>("");
	const [loaded, setLoaded] = useState(false);
	const [lastTurn, setLastTurn] = useState<MeterpalBlock | null>(null);
	// Bumped to rebuild the studio from the seed report.
	const [resetNonce, setResetNonce] = useState(0);

	// The customer whose usage is shown, and whose wallet pays for the agent.
	//
	// The list comes from the event log, not from the customer directory: a
	// studio is only interesting for customers that have actually spent
	// credits, and the directory is the wrong shape for that question.
	useEffect(() => {
		let cancelled = false;
		axios
			.post("/studio/customers", { limit: 100 })
			.then(({ data }) => {
				if (cancelled) return;
				const options: CustomerOption[] = (data?.customers ?? []).map(
					(customer: {
						id: string;
						name?: string | null;
						credits?: number;
						events?: number;
					}) => ({
						id: customer.id,
						name: customer.name ?? null,
						credits: customer.credits ?? 0,
						events: customer.events ?? 0,
					}),
				);
				setCustomers(options);
				// Default to the busiest customer, so the page opens on real data.
				setCustomerId((current) => current || options[0]?.id || "");
				setLoaded(true);
			})
			.catch(() => {
				// A customer list is a convenience; the studio still works without it.
				setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [axios]);

	const storageKey = reportStorageKey(customerId);

	// Studio reads `initialState` once, when it is created. Re-keying it on the
	// customer restarts the studio against that customer's saved report.
	const initialState = useMemo(
		() => readStoredReport(storageKey) ?? usageReport,
		[storageKey, resetNonce],
	);

	const data = useMemo(
		() => buildStudioData({ axios, customerId: customerId || undefined }),
		[axios, customerId],
	);

	const ai = useMemo(
		() =>
			buildStudioAi({
				axios,
				customerId,
				onMetered: (block) => setLastTurn(block),
			}),
		[axios, customerId],
	);

	const persist = useCallback(
		(state: AgReportState) => {
			try {
				window.localStorage.setItem(storageKey, JSON.stringify(state));
			} catch {
				// A full or disabled localStorage must not break the studio.
			}
		},
		[storageKey],
	);

	const selectedCustomer = customers.find((c) => c.id === customerId);

	// Back to the seeded dashboard. The agent's widgets live in the saved
	// report, so this drops them and rebuilds the studio from the seed.
	const reset = useCallback(() => {
		try {
			window.localStorage.removeItem(storageKey);
		} catch {
			// A disabled localStorage just means there is nothing to clear.
		}
		setResetNonce((nonce) => nonce + 1);
	}, [storageKey]);

	return (
		<PageContainer className="flex flex-col h-full min-h-0">
			<PageHeader
				icon={<ChartBarIcon size={16} weight="fill" className="text-subtle" />}
				title="Usage Studio"
				titleAccessory={
					customers.length > 0 ? (
						<div className="flex items-center gap-2">
							<Select value={customerId} onValueChange={setCustomerId}>
								<SelectTrigger size="sm" className="min-w-[180px]">
									<SelectValue placeholder="All customers" />
								</SelectTrigger>
								<SelectContent>
									{customers.map((customer) => (
										<SelectItem key={customer.id} value={customer.id}>
											{customer.name ?? customer.id}
											<span className="text-muted-foreground text-xs">
												{" "}
												· {Math.round(customer.credits * 100) / 100} credits
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								size="sm"
								variant="muted"
								onClick={reset}
								title="Reset the dashboard to its starting widgets"
							>
								<ArrowCounterClockwiseIcon size={14} />
								Reset
							</Button>
						</div>
					) : undefined
				}
			>
				<div className="text-xs text-muted-foreground">
					Every turn of the assistant is metered and billed to{" "}
					<span className="text-foreground font-medium">
						{selectedCustomer?.name ?? customerId ?? "this organization"}
					</span>
					{"'s"} MeterPal wallet
					{lastTurn?.credits_charged != null
						? ` — last turn cost ${lastTurn.credits_charged} credits`
						: ""}
					{lastTurn?.balance_after != null
						? `, balance ${lastTurn.balance_after}`
						: ""}
					.
				</div>
			</PageHeader>

			<div className="flex-1 min-h-0 rounded-lg border border-border overflow-hidden">
				{customerId ? (
					<AgStudioProvider
						modules={[AgStudioAiModule]}
						licenseKey={import.meta.env.VITE_AG_STUDIO_LICENSE_KEY}
					>
						<AgStudio
							key={resetNonce}
							style={{ height: "100%", width: "100%" }}
							data={data}
							ai={ai}
							initialState={initialState}
							mode="edit"
							enableFilterEditingInViewMode
							onStateUpdated={(event) => {
								persist(event.state);
							}}
						/>
					</AgStudioProvider>
				) : (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						{!loaded
							? "Loading customers…"
							: "No customer has recorded usage in this environment yet."}
					</div>
				)}
			</div>
		</PageContainer>
	);
};
