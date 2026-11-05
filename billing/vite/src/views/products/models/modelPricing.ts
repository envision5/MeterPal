// billing/vite/src/views/products/models/modelPricing.ts
//
// The price arithmetic the Models page shows.
//
// Every number here is derived from two facts the server owns: the merchant's
// own price for a model, and the markup that will actually be charged.  The
// dashboard never resolves markup on its own -- a second implementation of
// the precedence chain is how a preview drifts away from the invoice.

/** A price in USD per million tokens. */
export const formatUsd = (value: number | null | undefined): string => {
	if (value == null) return "—";
	return `$${value.toFixed(value < 1 ? 4 : 2)}`;
};

/**
 * The price the merchant charges per million input tokens, before markup.
 *
 * Their own price when they set one, the provider's price when they did not.
 */
export const baseInputPrice = (
	ownInput: number | null | undefined,
	providerInput: number | null | undefined,
): number | null => ownInput ?? providerInput ?? null;

/** The price per million output tokens, before markup. */
export const baseOutputPrice = (
	ownOutput: number | null | undefined,
	providerOutput: number | null | undefined,
): number | null => ownOutput ?? providerOutput ?? null;

/** The price a call actually costs: the base price plus the markup. */
export const withMarkup = (
	base: number | null,
	markupPct: number | null | undefined,
): number | null => {
	if (base == null) return null;
	return base * (1 + (markupPct ?? 0) / 100);
};

/**
 * The margin over the provider's price, as a percentage of the sale price.
 *
 * Null when there is nothing to compare against: no provider price, or a
 * price of zero (which would divide by zero and read as an infinite margin).
 */
export const marginPct = (
	effective: number | null,
	provider: number | null | undefined,
): number | null => {
	if (effective == null || provider == null) return null;
	if (effective <= 0 || provider <= 0) return null;
	return ((effective - provider) / effective) * 100;
};

/** How the charged markup reads on the page. */
export const markupLabel = (args: {
	source: "model" | "plan" | "none";
	effectivePct: number;
}): string => {
	if (args.source === "model") return `${args.effectivePct}%`;
	if (args.source === "plan") return `Plan ${args.effectivePct}%`;
	return "None";
};

/** The word for where a markup comes from, for a tooltip or a hint. */
export const markupSourceLabel = (
	source: "model" | "plan" | "none",
): string => {
	if (source === "model") return "your own markup";
	if (source === "plan") return "your plan's markup";
	return "no markup";
};
