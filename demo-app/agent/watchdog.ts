// demo-app/agent/watchdog.ts
//
// When should the buyer agent act on its own?
//
// The agent used to run only when a request came back with a 402, which made
// it reactive: the customer had to spend again before their wallet was
// topped up, and a customer who stopped using the product was never topped
// up at all.  The watchdog watches the wallet instead and fires the moment
// the credits run out.
//
// Two signals say "the wallet just ran dry":
//
//   - the core's depletion marker (customer metadata `balance_depleted`),
//     stamped at the exact transition inside the deduction, and
//   - the watcher seeing the balance go from positive to empty itself.
//
// Either one is enough.  The marker is the precise one — it also covers a
// depletion that happened while the watcher was down.  The observed
// transition is the fallback for a balance that emptied without the core
// stamping it (a plan switch, a reset, a direct grant).
//
// The decision is a pure function so it can be unit-tested without a
// billing server, and so the "already acted for this depletion" rule is
// enforced in one place.

export type WatchState = {
	/** The balance the watcher saw on its last poll (null = never seen). */
	lastBalance: number | null;
	/** The depletion marker the agent already acted on (null = none). */
	actedOnDepletionAt: number | null;
	/** True once the agent has fired for the current depletion. */
	fired: boolean;
};

export const initialWatchState = (): WatchState => ({
	lastBalance: null,
	actedOnDepletionAt: null,
	fired: false,
});

export type WatchInput = {
	/** The customer's spendable balance right now. */
	balance: number;
	/** The customer gave an agent a mandate. */
	mandateEnabled: boolean;
	/** A checkout is already open and waiting for the human. */
	pendingCheckout: boolean;
	/** The core's depletion marker timestamp (epoch ms), if any. */
	depletionAt: number | null;
	/** What the watcher knew on its last poll. */
	state: WatchState;
};

export type WatchDecision = {
	action: "wait" | "fire";
	reason: string;
	state: WatchState;
};

export const decideAgentAction = ({
	balance,
	mandateEnabled,
	pendingCheckout,
	depletionAt,
	state,
}: WatchInput): WatchDecision => {
	// The wallet has credits again: whatever depletion we were acting on is
	// over, and the next one starts a fresh episode.
	if (balance > 0) {
		return {
			action: "wait",
			reason: "wallet has credits",
			state: {
				lastBalance: balance,
				actedOnDepletionAt: null,
				fired: false,
			},
		};
	}

	if (!mandateEnabled) {
		return {
			action: "wait",
			reason: "no buyer-agent mandate",
			state: { ...state, lastBalance: balance },
		};
	}

	if (pendingCheckout) {
		return {
			action: "wait",
			reason: "a checkout is already open",
			state: { ...state, lastBalance: balance },
		};
	}

	// One firing per depletion episode.  Without this the agent could ask
	// twice: once because it saw the balance empty, and again because the
	// core's marker landed a poll later.
	if (state.fired) {
		return {
			action: "wait",
			reason: "already acted for this depletion",
			state: { ...state, lastBalance: balance },
		};
	}

	const markerIsNew =
		depletionAt != null && depletionAt !== state.actedOnDepletionAt;
	const transitionObserved =
		state.lastBalance != null && state.lastBalance > 0 && balance <= 0;

	if (!markerIsNew && !transitionObserved) {
		return {
			action: "wait",
			reason: "no new depletion",
			state: { ...state, lastBalance: balance },
		};
	}

	return {
		action: "fire",
		reason: markerIsNew
			? "the billing core recorded that the wallet just emptied"
			: "the balance went from positive to zero",
		state: {
			lastBalance: balance,
			actedOnDepletionAt: depletionAt ?? state.actedOnDepletionAt,
			fired: true,
		},
	};
};
