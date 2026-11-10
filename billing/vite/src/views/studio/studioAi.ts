// billing/vite/src/views/studio/studioAi.ts
//
// The agent harness.
//
// AG Studio's Agent Framework ships five built-in agents -- a lead that plans
// and delegates, plus specialists for data, layout, planning and widget
// configuration. `createAiHarness` wires them to an LLM adapter, and the
// adapter is ours: it points at the metered endpoint, so every turn the
// agents take is billed to the customer's wallet.
//
// Nothing here is AG-specific plumbing we had to write; the harness is AG's.
// What we supply is the model, and the model is metered.

import {
	createAiHarness,
	type AgAiHarnessSetup,
	type AgAiPromptStarter,
	type AgStudioApi,
} from "ag-studio";
import type { AxiosInstance } from "axios";
import { createMeteredAdapter, type MeterpalBlock } from "./studioAdapter.js";

/** What the assistant is offered before anything has been typed. */
const PROMPT_STARTERS: AgAiPromptStarter[] = [
	{
		label: "Spend over time",
		prompt:
			"Add a chart of credits spent per day for this customer, so I can see when usage peaked.",
	},
	{
		label: "Breakdown by feature",
		prompt:
			"Add a chart of credits by event name, so I can see which feature is costing the most.",
	},
	{
		label: "Events per day",
		prompt:
			"Add a chart of tracked events per day for this customer, so I can see how busy it is.",
	},
	{
		label: "Summarise this page",
		prompt:
			"Summarise what this dashboard shows: every widget, the fields it reads, and what stands out.",
	},
];

export const buildStudioAi = ({
	axios,
	customerId,
	model,
	onMetered,
}: {
	axios: AxiosInstance;
	customerId: string;
	model?: string;
	onMetered?: (block: MeterpalBlock) => void;
}): AgAiHarnessSetup => {
	const adapter = createMeteredAdapter({ axios, customerId, model, onMetered });

	return ({ api }) =>
		createAiHarness(api as AgStudioApi, {
			adapter,
			primary: "lead",
			promptStarters: PROMPT_STARTERS,
		});
};
