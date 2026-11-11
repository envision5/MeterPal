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
//      inference path, so it costs credits and an empty wallet is a paywall.
//      Which wallet is the important part: the *merchant's* console wallet
//      (`meterpal-console`), never the customer whose usage is on screen.
//      A merchant exploring their own analytics must not be able to spend a
//      user's credits, and the picker's "· 42 credits" is that user's own
//      balance, not a budget the assistant draws on.
//
// Presentation notes:
//
//   - The studio is themed, not defaulted. `studioTheme` is AG's light theme;
//     left alone it paints #FFFFFF panels over a #161616 app. `meterpalStudioTheme`
//     is the same theme rebuilt from the dashboard's own tokens, and it follows
//     the app's light/dark switch through `data-ag-theme-mode`.
//
//   - The studio is laid out, not left at its defaults. AG's default is every
//     edit-mode panel at once -- assistant, filters, compose, data -- which
//     turns one page into five vertical strips. One panel opens by default
//     (the assistant); the builder panels wait behind their chevrons.

import {
	AgStudioAiModule,
	type AgPanelConfig,
	type AgReportState,
} from "ag-studio";
import { AgStudio, AgStudioProvider, type AgStudioRef } from "ag-studio-react";
import { ChartBarIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useTheme } from "@/contexts/ThemeProvider";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { buildStudioAi } from "./studioAi";
import { buildStudioData } from "./studioData";
import { repairOverlaps, repairUnboundWidgets } from "./studioLayout";
import { meterpalStudioTheme } from "./studioTheme";
import {
	defaultPanels,
	reportStorageKey,
	usageReport,
} from "./studioReport";

type CustomerOption = {
	id: string;
	name: string | null;
	credits: number;
	events: number;
};

/**
 * A turn, as the header reports it: every metered call the chain made.
 *
 * AG Studio's agent loop calls the adapter once per model step, so "the last
 * turn" is a sum, not a sample. `calls` is carried so the number explains
 * itself -- 1.51 credits across 7 model calls reads as a total, where 1.51
 * alone could be mistaken for one expensive completion.
 */
type StudioTurn = {
	credits: number;
	calls: number;
	modelId: string | null;
};

type TurnAccumulator = StudioTurn & { lastAt: number };

/**
 * How long a quiet gap ends a turn.
 *
 * Steps inside one chain are separated by a model call and client-side tool
 * execution, and a measured studio turn had gaps of 8s between them -- so the
 * window has to be comfortably longer than the slowest step, or the turn gets
 * counted in pieces and the header understates it again. Twenty seconds is
 * longer than any observed step and shorter than the time a person takes to
 * read a result and type a second prompt.
 *
 * The trade-off is explicit: two prompts typed within 20s of each other are
 * reported as one turn. Under-counting a turn is the defect being fixed;
 * over-counting two is the far smaller error.
 */
const TURN_IDLE_MS = 20_000;

/**
 * Which panels exist, and on which side.
 *
 * Left: the assistant, because it is the reason to be on this page.
 * Right: filters only. Every edit-mode panel Studio offers -- assistant,
 * filters, compose, data -- rendered at once turns one page into five vertical
 * strips, and three of those strips were spending 120px of a 786px studio to
 * show a rotated word each. Filters earns its place: it is the one builder
 * tool a merchant uses while *reading* the dashboard rather than building it.
 * It opens collapsed, so the canvas is what you see first.
 */
const STUDIO_PANELS: AgPanelConfig = {
	edit: {
		left: ["ai"],
		right: ["filters"],
	},
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
	const { isDark } = useTheme();

	const [customers, setCustomers] = useState<CustomerOption[]>([]);
	const [customerId, setCustomerId] = useState<string>("");
	const [loaded, setLoaded] = useState(false);
	// What the last TURN cost -- not the last model call.
	//
	// The adapter is called once per model step, and one prompt routinely
	// takes seven of them (plan, query, place, delegate, configure, finish).
	// Reporting the final call's charge as "last turn" understated a real
	// turn by ~9x in a product whose entire claim is that it meters every
	// token, so the header now sums the chain.
	const [turn, setTurn] = useState<StudioTurn | null>(null);
	const turnRef = useRef<TurnAccumulator | null>(null);
	const turnTimer = useRef<number | null>(null);
	// Set when the gateway refused a turn for lack of balance.
	const [paywalled, setPaywalled] = useState<boolean>(false);
	// The console wallet -- what the assistant spends from. Null until the
	// first turn creates it.
	const [walletBalance, setWalletBalance] = useState<number | null>(null);
	const [walletReady, setWalletReady] = useState(false);
	// Bumped to rebuild the studio from the seed report.
	const [resetNonce, setResetNonce] = useState(0);
	// The live Studio api, for the one write we make on its behalf: moving a
	// widget the agent placed on top of another.
	const studioRef = useRef<AgStudioRef | null>(null);
	// Guards the repair's own setState from re-entering the state-updated
	// handler it was called from.
	const repairing = useRef(false);
	// How many widgets the last repair moved, for the note under the title.
	const [relocated, setRelocated] = useState(0);

	// The customer whose usage is shown.
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
				// The console wallet is the payer. Its balance is the one the
				// header shows -- the picker's per-customer credits belong to
				// that customer and are none of the assistant's business.
				setWalletBalance(data?.wallet?.balance ?? null);
				setWalletReady(Boolean(data?.wallet?.provisioned));
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
	//
	// Panels are merged rather than taken from the saved report: a report saved
	// before a panel default existed would otherwise keep the old one forever.
	const initialState = useMemo(() => {
		const stored = readStoredReport(storageKey) ?? usageReport;
		return {
			...stored,
			panels: { ...defaultPanels, ...stored.panels },
		} satisfies AgReportState;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [storageKey, resetNonce]);

	const data = useMemo(
		() => buildStudioData({ axios, customerId: customerId || undefined }),
		[axios, customerId],
	);

	const ai = useMemo(
		() =>
			buildStudioAi({
				axios,
				customerId,
				onMetered: (block) => {
					// Add this call to the running turn. The accumulator is a
					// ref, not state: the adapter can fire several times inside
					// one React batch, and each read-modify-write has to see the
					// previous one.
					const now = Date.now();
					const prev = turnRef.current;
					const acc: TurnAccumulator =
						prev && now - prev.lastAt < TURN_IDLE_MS
							? prev
							: { credits: 0, calls: 0, modelId: null, lastAt: now };
					acc.credits += block.credits_charged ?? 0;
					acc.calls += 1;
					acc.lastAt = now;
					acc.modelId = block.model_id ?? acc.modelId;
					turnRef.current = acc;
					setTurn({
						credits: acc.credits,
						calls: acc.calls,
						modelId: acc.modelId,
					});

					// Close the turn on quiet, so a second prompt starts a new
					// one instead of being added to the first forever.
					if (turnTimer.current) window.clearTimeout(turnTimer.current);
					turnTimer.current = window.setTimeout(() => {
						turnRef.current = null;
					}, TURN_IDLE_MS);

					setPaywalled(false);
					setWalletReady(true);
					// The server settles the charge against the console wallet,
					// so its figure is the truth after every turn.
					if (block.balance_after != null) {
						setWalletBalance(block.balance_after);
					}
				},
				onPaywalled: (balance) => {
					// A refused turn spent nothing; the previous turn's total is
					// not this turn's cost and must not linger under the
					// "refused" note.
					turnRef.current = null;
					if (turnTimer.current) window.clearTimeout(turnTimer.current);
					setTurn(null);
					setPaywalled(true);
					setWalletReady(true);
					if (balance != null) setWalletBalance(balance);
				},
			}),
		[axios, customerId],
	);

	useEffect(
		() => () => {
			if (turnTimer.current) window.clearTimeout(turnTimer.current);
		},
		[],
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

	/**
	 * Persist every write, and fix the two things the agent gets wrong.
	 *
	 * 1. BINDING. A widget is a shell plus a `dataMapping`. The agent reliably
	 *    builds the shell and sometimes omits the mapping, which is not an
	 *    error anywhere in the stack — the widget simply renders "No Rows To
	 *    Show" under a perfectly good title. `repairUnboundWidgets` points it
	 *    at the table using the dimension its own title names.
	 *
	 * 2. PLACEMENT. A widget arrives with a layout, and that layout can land
	 *    on top of an existing tile. The agent reports "no overlaps detected"
	 *    either way, so the page — not the agent's summary — has to be the
	 *    thing that is right. `repairOverlaps` moves the offending widget
	 *    below the content and we write the repaired state back; both passes
	 *    are idempotent, so the write they trigger comes back with nothing to
	 *    do.
	 *
	 * The placement pass runs on a manual drag too, deliberately: a tile
	 * overlapping another is not a layout anyone wants, whichever hand placed
	 * it, and it only ever moves widgets the agent created — the seeded tiles
	 * a merchant dragged are never touched.
	 */
	const onStateUpdated = useCallback(
		(event: { state: AgReportState }) => {
			if (repairing.current) {
				persist(event.state);
				return;
			}
			const bound = repairUnboundWidgets(event.state);
			const base = bound?.state ?? event.state;
			const repaired = repairOverlaps(base);
			if (!bound && !repaired) {
				persist(event.state);
				return;
			}
			const next = repaired?.state ?? base;
			repairing.current = true;
			if (repaired) setRelocated(repaired.moved.length);
			try {
				studioRef.current?.api?.setState(next);
				persist(next);
			} finally {
				// Released on the next tick: setState is synchronous, but the
				// state-updated event it raises is dispatched after this frame.
				setTimeout(() => {
					repairing.current = false;
				}, 0);
			}
		},
		[persist],
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
		setTurn(null);
		turnRef.current = null;
		if (turnTimer.current) window.clearTimeout(turnTimer.current);
		setRelocated(0);
		setResetNonce((nonce) => nonce + 1);
	}, [storageKey]);

	const metered = turn != null;

	// What the assistant has left to spend, in credits.
	//
	// This is the console wallet's balance and only ever that. It used to
	// fall back to the selected customer's credits, which read as "the
	// assistant spends this user's balance" -- exactly the bug being fixed.
	const balanceLabel =
		walletBalance == null ? null : Math.round(walletBalance * 100) / 100;
	const creditsLabel = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;

	return (
		<PageContainer className="flex flex-col h-full min-h-0 gap-4">
			<div className="flex flex-col gap-1">
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
				/>

				{/*
				 * The metering note sits under the title, not beside it. Beside it
				 * competed with the customer picker for the same row, which is how
				 * "Usage Studio" ended up wrapping onto two lines.
				 *
				 * It names the console wallet as the payer on purpose. The note
				 * used to read "{customer}'s MeterPal wallet", which was both the
				 * visible symptom of the billing leak and the reason it looked
				 * intended. Viewing a customer is not billing them.
				 */}
				<div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
					<span
						aria-hidden
						className={`inline-block size-1.5 shrink-0 rounded-full ${
							paywalled
								? "bg-destructive"
								: metered
									? "bg-primary"
									: "bg-subtle/40"
						}`}
					/>
					<span className="truncate">
						The assistant is metered — each turn bills your{" "}
						<span className="text-foreground font-medium">
							MeterPal Console
						</span>{" "}
						wallet, never{" "}
						<span className="text-foreground font-medium">
							{/* `??` is not enough: an org with no customers yet hands
							    us an empty string, which is neither null nor
							    undefined, so the header rendered "never 's
							    wallet" with the subject missing. */}
							{selectedCustomer?.name?.trim() ||
								customerId?.trim() ||
								"the customer"}
						</span>
						{/* The possessive needs its noun. Without it the sentence
						    read "never Setup test's · console balance 234.86
						    credits" -- a dangling possessive followed by a
						    separator, which parses as though the balance were
						    the customer's. It is the console's. */}
						{"'s wallet"}
						{balanceLabel != null && (
							<>
								{" "}
								· console balance{" "}
								<span className="text-foreground font-medium">
									{creditsLabel(balanceLabel)}
								</span>
							</>
						)}
						{metered && (
							<>
								{" "}
								· this turn{" "}
								<span className="text-foreground font-medium">
									{creditsLabel(Math.round(turn.credits * 10_000) / 10_000)}
								</span>{" "}
								across{" "}
								<span className="text-foreground font-medium">
									{turn.calls} model call{turn.calls === 1 ? "" : "s"}
								</span>
								{turn.modelId ? ` on ${turn.modelId}` : ""}
							</>
						)}
						{paywalled && (
							<span className="text-destructive">
								{" "}
								· last turn was refused: the console wallet can't cover it
							</span>
						)}
						{relocated > 0 && (
							<span className="text-amber-300">
								{" "}
								· moved {relocated} agent widget
								{relocated === 1 ? "" : "s"} below the dashboard — the
								layout it proposed overlapped an existing tile
							</span>
						)}
						{!metered && !paywalled && !walletReady && (
							<span className="text-muted-foreground">
								{" "}
								· the console wallet is created on the first turn
							</span>
						)}
						{!metered && !paywalled && walletReady && "."}
					</span>
				</div>
			</div>

			{/*
			 * `ag-theme-mode` + `data-ag-theme-mode` is how Studio is told which
			 * colour mode to resolve from the theme: the attribute has to sit on
			 * an ancestor carrying the class. Scoping it here rather than on
			 * <html> keeps any other AG instance in the app unaffected.
			 */}
			<div
				className="ag-theme-mode flex-1 min-h-0 rounded-xl border border-border bg-background overflow-hidden"
				data-ag-theme-mode={isDark ? "dark" : "light"}
			>
				{customerId ? (
					<AgStudioProvider
						modules={[AgStudioAiModule]}
						licenseKey={import.meta.env.VITE_AG_STUDIO_LICENSE_KEY}
					>
						<AgStudio
							// The key carries the customer, not just the reset
							// counter. Studio reads `initialState` and `data` once,
							// when it is created; re-rendering it with a different
							// customer left the previous customer's rows on the
							// canvas under the new customer's name — no error, no
							// spinner, just someone else's numbers. Remounting on
							// the storage key is what makes the picker re-scope.
							key={`${resetNonce}:${storageKey}`}
							ref={studioRef}
							style={{ height: "100%", width: "100%" }}
							theme={meterpalStudioTheme}
							panels={STUDIO_PANELS}
							data={data}
							ai={ai}
							initialState={initialState}
							mode="edit"
							enableFilterEditingInViewMode
							onStateUpdated={onStateUpdated}
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
