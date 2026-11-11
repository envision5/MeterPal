// billing/vite/src/views/studio/studioReport.ts
//
// The starting report.
//
// A studio opens on a report: a set of pages, each holding widgets and their
// layout. This is the report the usage dashboard opens on -- the numbers a
// merchant wants before they ask the agent for anything.
//
// The layout is a 24-column grid, read top to bottom as three questions:
//
//   1. How much? Four tiles, one per headline number.
//   2. When, and from what? A trend and a breakdown, side by side.
//   3. Which rows? The detail, full width, because a table is the one widget
//      that always wants more room.
//
// The agent can add to it. That is the point: the widgets below are the
// baseline, and anything the agent builds sits alongside them.

import type {
	AgPageState,
	AgPanelsState,
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
const countDistinct = (id: string) => ({ id, aggregation: "countd" as const });

const field = (column: string) => `${USAGE_TABLE_ID}.${column}`;

const usagePage: AgPageState = {
	id: "usage",
	widgets: {
		"kpi-credits": {
			type: "value",
			dataMapping: { value: [sum(field("credits"))] },
			format: title("Credits"),
		},
		"kpi-events": {
			type: "value",
			dataMapping: { value: [sum(field("events"))] },
			format: title("Events"),
		},
		"kpi-features": {
			type: "value",
			dataMapping: { value: [countDistinct(field("event_name"))] },
			format: title("Features"),
		},
		"kpi-days": {
			type: "value",
			dataMapping: { value: [countDistinct(field("period"))] },
			format: title("Days"),
		},
		"spend-over-time": {
			type: "line-chart",
			dataMapping: {
				categoryKey: [{ id: field("period") }],
				valueKey: [sum(field("credits"))],
			},
			format: title("Credits per day"),
		},
		"by-feature": {
			type: "donut-chart",
			dataMapping: {
				categoryKey: [{ id: field("event_name") }],
				valueKey: [sum(field("credits"))],
			},
			format: title("By feature"),
		},
		"usage-table": {
			type: "grid",
			dataMapping: {
				// Four columns, not five: at the width this canvas actually gets
				// with the assistant open, a fifth column is a horizontal
				// scrollbar and a half-word at the right edge.
				cols: [
					{ id: field("period") },
					{ id: field("event_name") },
					{ id: field("customer_id") },
					sum(field("credits")),
				],
			},
			sort: [{ field: { id: field("period") }, direction: "desc" }],
			format: title("Usage detail"),
		},
	},
	widgetLayout: {
		// Four tiles across: the headline numbers, all at the same weight.
		"kpi-credits": at(0, 0, 6, 5),
		"kpi-events": at(6, 0, 6, 5),
		"kpi-features": at(12, 0, 6, 5),
		"kpi-days": at(18, 0, 6, 5),
		// Trend leads, breakdown supports.
		"spend-over-time": at(0, 5, 15, 16),
		"by-feature": at(15, 5, 9, 16),
		// The detail, full width.
		"usage-table": at(0, 21, 24, 18),
	},
};

/**
 * Which panels a freshly-opened studio shows.
 *
 * Studio's default is all four edit-mode panels at once -- assistant, filters,
 * compose and data -- which on a laptop leaves the canvas a few hundred pixels
 * wide and splits the page into five vertical strips. So the default here is
 * one open panel (the assistant, because it is the reason to be on this page)
 * and filters collapsed to its chevron, one click away when needed.
 */
export const defaultPanels: AgPanelsState = {
	ai: { collapsed: false },
	filters: { collapsed: true },
};

/** The report the studio opens on. */
export const usageReport: AgReportState = {
	selectedPageId: usagePage.id,
	pages: [usagePage],
	panels: defaultPanels,
};

/**
 * The report for one customer, keyed in local storage by customer id.
 *
 * Versioned: the seed layout changed shape (four tiles instead of two, a new
 * default panel set), and a report saved against the old shape would open on
 * the old shape forever. A new key retires those saved reports instead of
 * silently overriding the new defaults.
 */
export const reportStorageKey = (customerId?: string) =>
	`meterpal.studio.report.v2.${customerId ?? "org"}`;
