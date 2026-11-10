// billing/vite/src/views/studio/studioData.ts
//
// AG Studio's data source for the usage dashboard.
//
// AG Studio ships no database connectors: the app supplies the data. This is
// the app supplying it -- one fact table, `usage`, holding the metered usage
// the dashboard already shows, read through the billing server's own analytics
// read path (Tinybird in production, Postgres locally).
//
// The source is asynchronous on purpose: the data comes from the server, and
// declaring no server-side capabilities lets Studio's own engine handle
// pagination, filtering and sorting in the browser. The local dataset is far
// below the engine's limit, so the simplest correct contract is the one with
// the fewest ways to be subtly wrong.

import type {
	AgDataSourcesDefinition,
	AgFieldDefinition,
} from "ag-studio";
import type { AxiosInstance } from "axios";

/** The table the dashboard's charts read. */
export const USAGE_TABLE_ID = "usage";
const CALENDAR_ID = "calendar";

/** The window the server reads when the caller does not name one. */
const DEFAULT_WINDOW_DAYS = 30;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const USAGE_FIELDS: AgFieldDefinition[] = [
	{ id: "period", name: "Date", format: "dateFormat" },
	{ id: "event_name", name: "Event", format: "textFormat" },
	{ id: "customer_id", name: "Customer", format: "textFormat" },
	{ id: "credits", name: "Credits", format: "decimalFormat" },
	{ id: "events", name: "Events", format: "integerFormat" },
];

export type UsageRow = {
	period: string;
	event_name: string;
	customer_id: string;
	credits: number;
	events: number;
};

/**
 * Build the data definition Studio reads.
 *
 * `customerId` scopes the table to one customer. Scoping happens on the
 * server, so the browser never sees another customer's rows.
 */
export const buildStudioData = ({
	axios,
	customerId,
}: {
	axios: AxiosInstance;
	customerId?: string;
}): AgDataSourcesDefinition => {
	const today = new Date();
	const from = new Date(
		today.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
	);

	return {
		description:
			"Metered usage for this organization, one row per (day, event, customer). " +
			"`credits` is the value spent -- the amount billed to the customer's wallet -- " +
			"and `events` is how many tracked events it came from. A row with no value " +
			"counts as one credit, which is how the billing engine treats it too.",
		sources: [
			{
				id: USAGE_TABLE_ID,
				dataShape: "row",
				tables: [
					{
						id: USAGE_TABLE_ID,
						name: "Daily usage",
						description:
							"Metered usage per day. `credits` is what was billed; `events` is how many tracked events produced it.",
						fields: USAGE_FIELDS,
					},
				],
				getData: async () => {
					// The server answers `{ data: [...] }`. Axios hands us that
					// body, so the rows sit one level below the destructured
					// `data` -- AG Studio wants `{ data: [...] }` back.
					const { data } = await axios.post("/studio/data", {
						table: "usage_daily",
						...(customerId ? { customer_id: customerId } : {}),
					});
					return { data: (data?.data ?? []) as UsageRow[] };
				},
			},
		],
		relationships: [
			{
				id: `${USAGE_TABLE_ID}-period-calendar`,
				source: { tableId: USAGE_TABLE_ID, fieldId: "period" },
				target: { calendarId: CALENDAR_ID },
			},
		],
		calendars: [
			{
				id: CALENDAR_ID,
				label: "Date",
				range: {
					from: { type: "date", value: isoDate(from) },
					to: { type: "date", value: isoDate(today) },
				},
				fragments: ["year", "quarter", "month", "week", "day", "dayOfWeek"],
			},
		],
	};
};
