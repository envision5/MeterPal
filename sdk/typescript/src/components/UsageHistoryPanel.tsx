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
  const events: any[] = (data as any)?.list ?? [];

  // "By model" aggregates computed client-side from the same page of events —
  // one request, no separate aggregation call.
  const byModel = new Map<string, { credits: number; count: number }>();
  for (const evt of events) {
    const model = evt.properties?.model_id ?? evt.properties?.model ?? "other";
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
        <h3 className="font-semibold">This month, by model</h3>
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
                  {agg.credits.toFixed(2)}
                </td>
              </tr>
            ))}
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
            {events.map((evt) => (
              <tr key={evt.id} className="border-t border-border">
                <td className="py-2">
                  {new Date(evt.timestamp).toLocaleString()}
                </td>
                <td className="py-2">
                  {evt.properties?.model_id ?? evt.properties?.model ?? "—"}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {evt.properties?.input_tokens ?? 0} /{" "}
                  {evt.properties?.output_tokens ?? 0}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {Number(evt.value ?? 0).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
