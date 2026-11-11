// billing/vite/src/views/studio/studioAi.ts
//
// The agent harness.
//
// AG Studio's Agent Framework ships five built-in agents -- a lead that plans
// and delegates, plus specialists for data, layout, planning and widget
// configuration. `createAiHarness` wires them to an LLM adapter, and the
// adapter is ours: it points at the metered endpoint, so every turn the
// agents take is billed -- to the merchant's console wallet, never to the
// customer whose dashboard is on screen.
//
// Nothing here is AG-specific plumbing we had to write; the harness is AG's.
// What we supply is the model, and the model is metered.

import {
	createAiHarness,
	directLlmRunner,
	type AgAiAgentContext,
	type AgAiHarnessSetup,
	type AgAiPromptStarter,
	type AgAnyAiAgentDefinition,
	type AgStudioApi,
} from "ag-studio";
import type { AxiosInstance } from "axios";
import { createMeteredAdapter, type MeterpalBlock } from "./studioAdapter.js";

/**
 * What the layout agent is told, in addition to AG's own prompt.
 *
 * The seed page occupies rows 0–38 of the 24-column canvas: four KPI tiles at
 * the top, a trend and a breakdown beneath them, and the detail table last.
 * Told nothing, the agent proposes a layout of its own — and a layout that
 * lands on the KPI tiles is still a valid page, so it reports success while
 * the chart sits on top of the numbers.  `repairOverlaps` in the view moves
 * the widget afterwards; this stops it needing to.
 */
const LAYOUT_GUIDE = `
Placement rules for this dashboard:

- The page already has widgets. Read the current page layout before adding
  anything, and APPEND: a new widget goes below the lowest existing widget,
  at yTrack equal to the largest (yTrack + ySpan) on the page. Never place a
  widget over an existing one, and never assume the canvas is empty.
- Keep the width the request implies (a chart wants about 12 columns, a KPI
  tile 6, a table the full 24) and give a chart at least 12 rows of height.
- A widget that overlaps an existing widget is a defect, not a preference.
  If a placement tool reports a collision, move the widget; do not report
  success with a known collision.
`;

/**
 * What the widget agent is told about the data.
 *
 * A widget is a shell (`type`) plus a `dataMapping`, and the two are supplied
 * separately. Built without the mapping, a grid is still a valid widget — it
 * just renders "No Rows To Show" with an "Add Data" prompt, and the agent's
 * summary reports success. Naming the exact field ids and the exact mapping
 * shape is cheaper than a second turn, and it is the difference between a
 * demo that ends on a table of real rows and one that ends on an empty grid.
 */
const DATA_BINDING_GUIDE = `
Every widget you create MUST have a dataMapping. A widget without one renders
empty, and an empty widget is a failed task, not a finished one.

The only table is \`usage\`, with these fields (always write them fully
qualified as shown):

- \`usage.period\`     — date (the day the usage happened)
- \`usage.event_name\` — what was metered (e.g. the model or feature)
- \`usage.customer_id\` — which end user
- \`usage.credits\`    — credits spent (the amount billed)
- \`usage.events\`     — how many tracked events produced it

Mapping shapes, by widget type:

- grid / table / pivot:
  \`dataMapping: { cols: [{ id: "usage.customer_id" }, { id: "usage.credits", aggregation: "sum" }] }\`
  Put the grouping column FIRST. "One row per customer" means grouping on
  \`usage.customer_id\`; "by feature" means \`usage.event_name\`; "per day"
  means \`usage.period\`.
- any chart (line / bar / column / area / donut / pie):
  \`dataMapping: { categoryKey: [{ id: "usage.period" }], valueKey: [{ id: "usage.credits", aggregation: "sum" }] }\`
  Use \`usage.period\` for a trend, \`usage.event_name\` or
  \`usage.customer_id\` for a breakdown.
- value / KPI:
  \`dataMapping: { value: [{ id: "usage.credits", aggregation: "sum" }] }\`

Aggregations available: "sum", "avg", "min", "max", "count", "countd".
`;

/**
 * What the widget agent is told about finishing.
 *
 * A delegated run that ends without calling `complete_task` leaves the
 * delegating agent with nothing to report, and the user reads "the delegate
 * finished without a summary" instead of what was built.  Both fields are
 * required by the tool; saying so here is cheaper than a second round trip.
 */
const COMPLETION_GUIDE = `
When you are done, call complete_task with BOTH fields:

- \`summary\`: one sentence naming the widget you built and what it shows.
- \`artifacts\`: the widget ids you created or changed.

A run that ends without both is reported to the user as having finished
without a summary, which is a worse answer than the work deserves.
`;

/** Append our guidance to an agent's own instructions. */
const withGuide =
	(
		base: AgAnyAiAgentDefinition,
		guide: string,
	): AgAnyAiAgentDefinition["instructions"] =>
	(ctx: AgAiAgentContext, params: never) => {
		const own = base.instructions?.(ctx, params);
		return own ? `${own}\n${guide}` : guide;
	};


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
	onPaywalled,
}: {
	axios: AxiosInstance;
	/** Whose usage is on screen. Scope only -- the merchant's wallet pays. */
	customerId: string;
	model?: string;
	onMetered?: (block: MeterpalBlock) => void;
	onPaywalled?: (balance: number | null) => void;
}): AgAiHarnessSetup => {
	const adapter = createMeteredAdapter({
		axios,
		scopeCustomerId: customerId,
		model,
		onMetered,
		onPaywalled,
	});

	// AG's five agents, with two of them given the guidance they were missing.
	//
	// The config-builder form (rather than the defaults object) is what makes
	// that possible: it hands back AG's own definitions so each one can be
	// spread and re-pointed, and it is still AG's harness, AG's loop and AG's
	// tools underneath -- only the instructions differ.
	return ({ api }) =>
		createAiHarness(api as AgStudioApi, ({ builtIn }) => ({
			agents: [
				directLlmRunner({ ...builtIn.lead, adapter }),
				directLlmRunner({ ...builtIn.data, adapter }),
				directLlmRunner({
					...builtIn.page,
					adapter,
					instructions: withGuide(builtIn.page, LAYOUT_GUIDE),
				}),
				directLlmRunner({ ...builtIn.planning, adapter }),
				directLlmRunner({
					...builtIn.widget,
					adapter,
					instructions: withGuide(
						builtIn.widget,
						`${DATA_BINDING_GUIDE}\n${COMPLETION_GUIDE}`,
					),
				}),
			],
			primary: "lead",
			promptStarters: PROMPT_STARTERS,
		}));
};
