// billing/vite/src/views/studio/studioLayout.ts
//
// Keeping agent-placed widgets off each other.
//
// Studio's canvas is a 24-column grid of absolutely-positioned tracks, and a
// widget the agent adds arrives with a layout of its own.  When that layout
// lands on top of an existing tile the page is still *valid* — every widget
// has a position — but it is unreadable: the new chart is drawn over the KPI
// tiles, and the agent, having been told "no overlaps detected", reports
// success.
//
// Studio repairs some of this itself, but its repair is a re-placement, and a
// re-placement can land on something else.  This is the deterministic pass
// that runs after every state write: if two widgets share a cell, the one that
// is not part of the seed dashboard is moved below everything else.  The seed
// widgets never move — they are the page the merchant recognises — and the
// pass is idempotent, so a repaired state does not ask to be repaired again
// (which would loop).

import type { AgReportState, AgWidgetLayoutState } from "ag-studio";
import { USAGE_TABLE_ID } from "./studioData";
import { usageReport } from "./studioReport";

/** The widgets that belong to the seed dashboard, and never get moved. */
const seedWidgetIds = new Set(
	Object.keys(usageReport.pages[0]?.widgetLayout ?? {}),
);

type Rect = AgWidgetLayoutState;

const overlaps = (a: Rect, b: Rect): boolean =>
	a.xTrack < b.xTrack + b.xSpan &&
	b.xTrack < a.xTrack + a.xSpan &&
	a.yTrack < b.yTrack + b.ySpan &&
	b.yTrack < a.yTrack + a.ySpan;

const bottom = (r: Rect): number => r.yTrack + r.ySpan;

/**
 * Move every overlapping widget below the content it collides with.
 *
 * Returns the repaired state plus the ids it moved, so the caller can log or
 * show what happened.  Returns `null` when there was nothing to repair — the
 * common case, and the reason this can sit on the state-updated path.
 */
export const repairOverlaps = (
	state: AgReportState,
): { state: AgReportState; moved: string[] } | null => {
	const moved: string[] = [];

	const pages = state.pages.map((page) => {
		const layout = page.widgetLayout;
		if (!layout) return page;

		// Seed widgets claim their cells first, so nothing the agent added can
		// push them around; then everything else, top to bottom.
		const ids = Object.keys(layout).sort((a, b) => {
			const aSeed = seedWidgetIds.has(a) ? 0 : 1;
			const bSeed = seedWidgetIds.has(b) ? 0 : 1;
			if (aSeed !== bSeed) return aSeed - bSeed;
			return (layout[a]?.yTrack ?? 0) - (layout[b]?.yTrack ?? 0);
		});

		const placed: Rect[] = [];
		const next: Record<string, Rect> = {};
		let changed = false;

		for (const id of ids) {
			const rect = layout[id];
			if (!rect) continue;

			if (!placed.some((other) => overlaps(rect, other))) {
				placed.push(rect);
				next[id] = rect;
				continue;
			}

			// Move below the widget it collided with, not below the whole
			// page. Relocating to the global bottom is correct but leaves a
			// band of empty canvas between the tile and the thing it was
			// moved away from, which reads as a gap in the dashboard rather
			// than a placement. Dropping it into the first free row under the
			// collision looks like someone put it there on purpose.
			let relocated: Rect = {
				...rect,
				xTrack: 0,
				yTrack: placed
					.filter((other) => overlaps(rect, other))
					.reduce((max, r) => Math.max(max, bottom(r)), rect.yTrack),
			};
			// Landing under one blocker can put it on top of the next one
			// down. Each pass pushes past every box it now touches, and
			// `yTrack` strictly increases on each one, so this terminates.
			for (;;) {
				const blockers = placed.filter((other) => overlaps(relocated, other));
				if (blockers.length === 0) break;
				relocated = {
					...relocated,
					yTrack: blockers.reduce(
						(max, r) => Math.max(max, bottom(r)),
						relocated.yTrack,
					),
				};
			}
			placed.push(relocated);
			next[id] = relocated;
			moved.push(id);
			changed = true;
		}

		return changed ? { ...page, widgetLayout: next } : page;
	});

	if (moved.length === 0) return null;

	return { state: { ...state, pages }, moved };
};

// ---------------------------------------------------------------------------
// Binding a widget the agent built but never pointed at the data
// ---------------------------------------------------------------------------
//
// A widget's shell and its data are separate: `type` decides what is drawn,
// `dataMapping` decides what it is drawn FROM. The agent reliably produces the
// first and sometimes omits the second, which is not an error anywhere in the
// stack -- the widget is valid, it just renders "No Rows To Show" with an
// "Add Data" prompt. A round-1 chart came out with real bars and a round-2
// table came out empty for exactly this reason.
//
// So the same deterministic pass that fixes placement fixes binding: a widget
// with no mapping gets the mapping its own title implies, against the one
// table this dashboard has.

/** A widget state, as far as binding is concerned. */
type WidgetState = {
	type?: string;
	dataMapping?: Record<string, unknown>;
	format?: {
		title?: { text?: string };
		style?: { grandTotalRow?: { enabled?: boolean } };
	};
};

const usageField = (column: string) => `${USAGE_TABLE_ID}.${column}`;
const sumOf = (column: string) => ({
	id: usageField(column),
	aggregation: "sum" as const,
});

/**
 * The field a widget's own title says it is about.
 *
 * Only three things get grouped in this dashboard -- who, what, and when --
 * so the title is a reliable enough signal, and the fallback (date) is the
 * shape every chart here wants anyway.
 */
const categoryFor = (title: string): string => {
	const text = title.toLowerCase();
	if (/customer|account|tenant|payer|who/.test(text)) return "customer_id";
	if (/feature|event|model|product|what/.test(text)) return "event_name";
	return "period";
};

/**
 * Does this mapping actually point at any data?
 *
 * A mapping is per-type, and Studio stores whatever keys it is given: a
 * chart-shaped mapping (`categoryKey`/`valueKey`) applied to a grid leaves the
 * grid's own `cols` as an empty array. The widget then has a `dataMapping`
 * object that passes a `Object.keys().length > 0` test while binding nothing,
 * which is exactly how the table beat still came out empty after the agent was
 * taught the right shape -- the mapping was there, the columns were not.
 *
 * So the test is on the *keys this widget type reads*, not on the object being
 * non-empty.
 */
const bindsData = (type: string, mapping: Record<string, unknown>): boolean => {
	const filled = (key: string): boolean => {
		const value = mapping[key];
		return Array.isArray(value) ? value.length > 0 : value != null;
	};

	if (/grid|table|list|pivot/.test(type)) return filled("cols");
	if (/chart|plot|graph|gauge|funnel|radar/.test(type)) {
		return filled("categoryKey") && filled("valueKey");
	}
	if (type === "value" || type === "kpi" || type === "multi-kpi") {
		return filled("value");
	}
	// An unknown widget type: any mapping at all is as good a signal as we have.
	return Object.keys(mapping).length > 0;
};

/**
 * The mapping a widget of this shape should have, plus any presentation that
 * only makes sense alongside it.
 */
type Binding = {
	dataMapping: Record<string, unknown>;
	format?: NonNullable<WidgetState["format"]>;
};

const mappingFor = (widget: WidgetState): Binding | null => {
	const type = widget.type ?? "";
	const category = categoryFor(widget.format?.title?.text ?? "");

	// Charts: one dimension, one measure.
	if (/chart|plot|graph|gauge|funnel|radar/.test(type)) {
		return {
			dataMapping: {
				categoryKey: [{ id: usageField(category) }],
				valueKey: [sumOf("credits")],
			},
		};
	}

	// A single number: the total it is about.
	if (type === "value" || type === "kpi" || type === "multi-kpi") {
		return { dataMapping: { value: [sumOf("credits")] } };
	}

	// A grid: the grouping column first, then the measure. Grouping on the
	// dimension the title names is what makes "one row per customer" true
	// rather than a wall of daily rows.
	//
	// Every entry in a grid's `cols` needs an `aggregation` — the schema is a
	// union whose every branch requires one, and an entry that fails is
	// dropped rather than rejected, which leaves `cols: []` and an empty
	// grid. "first" groups: one row per distinct category.
	if (/grid|table|list|pivot/.test(type)) {
		const grouped = category !== "period";
		const cols = grouped
			? [{ id: usageField(category), aggregation: "first" }, sumOf("credits")]
			: [
					{ id: usageField("period"), aggregation: "first" },
					{ id: usageField("event_name"), aggregation: "first" },
					{ id: usageField("customer_id"), aggregation: "first" },
					sumOf("credits"),
				];

		return {
			dataMapping: { cols },
			// A grouped grid's grand-total row repeats the group's own value:
			// the footer has no "Total" label to put in the first column, so
			// it aggregates that column with the same `first` the body uses
			// and the customer name appears twice, one under the other, both
			// reading 0.13. The row above already is the total, so the footer
			// comes off. Ungrouped grids keep theirs -- there the label lands
			// in an empty first column and reads as a total.
			...(grouped
				? { format: { style: { grandTotalRow: { enabled: false } } } }
				: {}),
		};
	}

	return null;
};

/**
 * Give every widget that binds nothing the mapping its title implies.
 *
 * "Binds nothing" is not the same as "has no mapping": a widget can carry a
 * mapping of the wrong *shape* for its type -- see `bindsData`. Both cases end
 * in the same empty tile, so both are repaired here.
 *
 * Returns `null` when every widget already binds data -- the common case,
 * since the agent usually does bind what it builds.
 */
export const repairUnboundWidgets = (
	state: AgReportState,
): { state: AgReportState; bound: string[] } | null => {
	const bound: string[] = [];

	const pages = state.pages.map((page) => {
		const widgets = page.widgets as Record<string, WidgetState> | undefined;
		if (!widgets) return page;

		let changed = false;
		const next: Record<string, WidgetState> = {};

		for (const [id, widget] of Object.entries(widgets)) {
			const mapping = widget.dataMapping;
			if (mapping && bindsData(widget.type ?? "", mapping)) {
				next[id] = widget;
				continue;
			}
			const inferred = mappingFor(widget);
			if (!inferred) {
				next[id] = widget;
				continue;
			}
			next[id] = {
				...widget,
				dataMapping: inferred.dataMapping,
				format: {
					...widget.format,
					...inferred.format,
					...(inferred.format?.style && widget.format?.style
						? { style: { ...widget.format.style, ...inferred.format.style } }
						: {}),
				},
			};
			bound.push(id);
			changed = true;
		}

		return changed
			? { ...page, widgets: next as typeof page.widgets }
			: page;
	});

	if (bound.length === 0) return null;

	return { state: { ...state, pages }, bound };
};
