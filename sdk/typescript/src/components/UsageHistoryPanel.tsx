"use client";

import { useListEvents } from "autumn-js/react";

interface UsageHistoryPanelProps {
  featureId?: string;
  /** Start of the usage window. Defaults to the first day of the current month. */
  rangeStart?: Date;
  /** End of the usage window. Defaults to now. */
  rangeEnd?: Date;
  /** Max events to fetch. Default 50. */
  limit?: number;
}

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * Credits at a precision that never rounds a real charge to nothing.
 *
 * Two decimals is right for a wallet balance in the tens, but a demo model
 * charges ~0.005 credits a turn: every row printed `0.01` while three of them
 * summed to `0.02`. The table looked like broken arithmetic. Scale the
 * precision to the magnitude instead, so rows and totals reconcile.
 */
function formatCredits(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1) return n.toFixed(2);
  // Five decimals, not four.
  //
  // A metered charge is routinely a fraction of a cent (0.00518 credits for a
  // short call), and rounding the parts harder than the total made the column
  // disagree with its own sum: 0.0256 + 3 × 0.0052 = 0.0412 against a true
  // 0.0411. Trailing zeros are trimmed, so 0.5 still reads "0.5" and 0.66
  // still reads "0.66" — only values that need the precision show it.
  const fixed = n.toFixed(5);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? fixed : trimmed;
}

/**
 * The token totals a request was charged for.
 *
 * A usage event splits its bill into pools: `input_tokens` excludes the part
 * the provider served from cache, and `output_tokens` excludes the tokens the
 * model spent reasoning, because each pool is priced separately.  Adding them
 * back gives the counts the credits were computed from, so the row reconciles
 * with its own charge instead of looking under-billed.
 */
function billedTokens(properties: Record<string, any> | undefined) {
  const num = (key: string) => Number(properties?.[key] ?? 0);
  return {
    input: num("input_tokens") + num("cache_read_tokens") + num("cache_write_tokens"),
    output: num("output_tokens") + num("reasoning_tokens"),
    cached: num("cache_read_tokens") + num("cache_write_tokens"),
    reasoning: num("reasoning_tokens"),
  };
}

/**
 * Whether an event is a billable request rather than internal bookkeeping.
 *
 * A metered call writes three events: the reservation taken at admission, its
 * release, and the settled charge.  Only the charge carries an idempotency
 * key.  The other two are the ledger's own machinery — listing them as
 * requests produced rows with no model, `0 / 0` tokens and a negative charge,
 * and a by-model bucket called "other" worth −6.55 credits.
 *
 * Two signals, in order of authority:
 *
 *   1. `idempotencyKey === null` — the server said so outright.
 *   2. The key is missing entirely, because an older adapter drops unknown
 *      fields, so fall back to the shape: a charge carries properties (model,
 *      rates, token pools) and a balance movement carries none.
 *
 * A key of `undefined` is NOT treated as "not a charge" on its own: hiding a
 * real request is worse than showing an internal row.
 */
function isCharge(evt: any): boolean {
  const key = evt?.idempotency_key ?? evt?.idempotencyKey;
  if (key === null) return false;
  if (typeof key === "string" && key.length > 0) return true;
  // Unknown: fall back to the shape.
  const properties = evt?.properties;
  return !!properties && Object.keys(properties).length > 0;
}

/**
 * Usage history for the current customer (identity resolved server-side by
 * the autumn-js backend adapter): per-model credit totals for the window,
 * plus the most recent metered requests.
 */
export function UsageHistoryPanel({
  featureId,
  rangeStart = startOfMonth(),
  rangeEnd = new Date(),
  limit = 50,
}: UsageHistoryPanelProps) {
  const { data } = useListEvents({
    ...(featureId ? { featureId } : {}),
    limit,
    customRange: {
      start: rangeStart.getTime(),
      end: rangeEnd.getTime(),
    },
  });

  // ListEventsResponse = { list: Event[], nextCursor }
  const rawEvents: any[] = (data as any)?.list ?? (data as any)?.events ?? [];
  // Charges only: the reservations and releases are not requests.
  const events = rawEvents.filter(isCharge);
  // True when the window holds more than this page, so the totals below are
  // "these requests", not "the month".  Saying the latter over a 50-row page
  // understated a customer's spend by more than 25×.
  //
  // Pagination is the only signal: filtering internal rows out is not
  // truncation, and treating it as such told a customer with three requests
  // that the ledger held more than the page.
  const truncated = Boolean((data as any)?.nextCursor) ||
    Boolean((data as any)?.has_more);

  // "By model" aggregates computed client-side from the same page of events —
  // one request, no separate aggregation call.
  const byModel = new Map<string, { credits: number; count: number }>();
  for (const evt of events) {
    const model =
      evt.properties?.model_id ?? evt.properties?.model ?? "unknown";
    const entry = byModel.get(model) ?? { credits: 0, count: 0 };
    entry.credits += Number(evt.value ?? 0);
    entry.count += 1;
    byModel.set(model, entry);
  }
  const modelRows = [...byModel.entries()].sort(
    (a, b) => b[1].credits - a[1].credits,
  );

  return (
    <div className="grid gap-4" data-testid="usage-history">
      <section className="rounded-xl border border-border p-5">
        <h3 className="font-semibold">
          {truncated ? "Recent requests, by model" : "This month, by model"}
        </h3>
        {truncated && (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="usage-window-note"
          >
            Totals cover the {events.length} most recent requests, not the whole
            month — the ledger holds more than this page.
          </p>
        )}
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="font-normal pb-2">Model</th>
              <th className="font-normal pb-2 text-right">Requests</th>
              <th className="font-normal pb-2 text-right">Credits</th>
            </tr>
          </thead>
          <tbody>
            {modelRows.length === 0 && (
              <tr>
                <td colSpan={3} className="py-3 text-muted-foreground">
                  No usage yet this month.
                </td>
              </tr>
            )}
            {modelRows.map(([model, agg]) => (
              <tr key={model} className="border-t border-border">
                <td className="py-2">{model}</td>
                <td className="py-2 text-right tabular-nums">{agg.count}</td>
                <td className="py-2 text-right tabular-nums">
                  {formatCredits(agg.credits)}
                </td>
              </tr>
            ))}
            {modelRows.length > 1 && (
              <tr className="border-t border-border font-medium">
                <td className="py-2">Total</td>
                <td className="py-2 text-right tabular-nums">
                  {events.length}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCredits(
                    events.reduce((sum, evt) => sum + Number(evt.value ?? 0), 0),
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-border p-5">
        <h3 className="font-semibold">Recent requests</h3>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="font-normal pb-2">When</th>
              <th className="font-normal pb-2">Model</th>
              <th className="font-normal pb-2 text-right">In / Out</th>
              <th className="font-normal pb-2 text-right">Credits</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-muted-foreground">
                  No requests yet.
                </td>
              </tr>
            )}
            {events.map((evt) => {
              const tokens = billedTokens(evt.properties);
              return (
                <tr key={evt.id} className="border-t border-border">
                  <td className="py-2">
                    {new Date(evt.timestamp).toLocaleString()}
                  </td>
                  <td className="py-2">
                    {evt.properties?.model_id ?? evt.properties?.model ?? "—"}
                  </td>
                  <td
                    className="py-2 text-right tabular-nums"
                    title={
                      tokens.cached || tokens.reasoning
                        ? `Includes ${tokens.cached} cached input and ${tokens.reasoning} reasoning tokens`
                        : undefined
                    }
                  >
                    {tokens.input} / {tokens.output}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatCredits(Number(evt.value ?? 0))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
