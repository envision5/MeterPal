// billing/vite/src/views/studio/studioReport.ts
//
// The starting report.
//
// A studio opens on a report: a set of pages, each holding widgets and their
// layout. This is the report the usage dashboard opens on -- the numbers a
// merchant wants before they ask the agent for anything.
//
// The agent can add to it. That is the point: the widgets below are the
// baseline, and anything the agent builds sits alongside them.

import type {
	AgPageState,
	AgReportState,
	AgWidgetLayoutState,
} from "ag-studio";
import { USAGE_TABLE_ID } from "./studioData";

// The canvas grid: 24 columns wide, rows of studioCanvasRowHeight.
const at = (
	xTrack: number,
	yTrack: number,
	xSpan: number,
	ySpan: number,
): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });

const title = (text: string) => ({ title: { enabled: true, text } });

const sum = (id: string) => ({ id, aggregation: "sum" as const });

const field = (column: string) => `${USAGE_TABLE_ID}.${column}`;

const usagePage: AgPageState = {
	id: "usage",
	widgets: {
		"kpi-credits": {
			type: "value",
			dataMapping: { value: [sum(field("credits"))] },
			format: {
				title: { enabled: true, text: "Credits spent" },
				style: { typography: { fontSize: 22 } },
			},
		},
		"kpi-events": {
			type: "value",
			dataMapping: { value: [sum(field("events"))] },
			format: {
				title: { enabled: true, text: "Tracked events" },
				style: { typography: { fontSize: 22 } },
			},
		},
		"spend-over-time": {
			type: "line-chart",
			dataMapping: {
				categoryKey: [{ id: field("period") }],
				valueKey: [sum(field("credits"))],
			},
			format: title("Credits spent per day"),
		},
		"by-feature": {
			type: "donut-chart",
			dataMapping: {
				categoryKey: [{ id: field("event_name") }],
				valueKey: [sum(field("credits"))],
			},
			format: title("Credits by feature"),
		},
		"usage-table": {
			type: "grid",
			dataMapping: {
				cols: [
					{ id: field("period") },
					{ id: field("event_name") },
					{ id: field("customer_id") },
					sum(field("credits")),
					sum(field("events")),
				],
			},
			sort: [{ field: { id: field("period") }, direction: "desc" }],
			format: title("Usage detail"),
		},
	},
	widgetLayout: {
		"kpi-credits": at(0, 0, 6, 7),
		"kpi-events": at(6, 0, 6, 7),
		"spend-over-time": at(12, 0, 12, 18),
		"by-feature": at(0, 7, 12, 18),
		"usage-table": at(0, 25, 24, 20),
	},
};

/** The report the studio opens on. */
export const usageReport: AgReportState = {
	selectedPageId: usagePage.id,
	pages: [usagePage],
};

/** The report for one customer, keyed in local storage by customer id. */
export const reportStorageKey = (customerId?: string) =>
	`meterpal.studio.report.${customerId ?? "org"}`;
