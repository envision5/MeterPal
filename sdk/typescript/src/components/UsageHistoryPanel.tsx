"use client";

import { useAggregateEvents, useListEvents } from "autumn-js/react";

interface UsageHistoryPanelProps {
  customerId: string;
  featureId?: string;
  /** First day of the billing window, default = start of current month. */
  rangeStart?: Date;
  /** Last day of the billing window, default = end of current month. */
  rangeEnd?: Date;
}

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function UsageHistoryPanel({
  customerId,
  featureId,
  rangeStart = startOfMonth(),
  rangeEnd = endOfMonth(),
}: UsageHistoryPanelProps) {
  const range = { start: rangeStart.toISOString(), end: rangeEnd.toISOString() };
  const { data: aggregates } = useAggregateEvents({ customerId, range });
  const { data: events } = useListEvents({ customerId, range, limit: 50 });

  const eventsArr = (events as any[]) ?? [];
  const aggregatesArr = (aggregates as any[]) ?? [];

  return (
    <div className="grid gap-4" data-testid="usage-history">
      <section className="rounded-xl border border-border p-5">
        <h3 className="font-semibold">This month, by model</h3>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="font-normal pb-2">Model</th>
              <th className="font-normal pb-2 text-right">Credits</th>
            </tr>
          </thead>
          <tbody>
            {aggregatesArr.length === 0 && (
              <tr>
                <td colSpan={2} className="py-3 text-muted-foreground">
                  No usage yet this month.
                </td>
              </tr>
            )}
            {aggregatesArr.map((row) => (
              <tr key={row.feature_id} className="border-t border-border">
                <td className="py-2">{row.feature_id}</td>
                <td className="py-2 text-right tabular-nums">
                  {Number(row.value).toFixed(2)}
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
            {eventsArr.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-muted-foreground">
                  No requests yet.
                </td>
              </tr>
            )}
            {eventsArr.map((evt) => (
              <tr key={evt.id} className="border-t border-border">
                <td className="py-2">
                  {new Date(evt.timestamp).toLocaleString()}
                </td>
                <td className="py-2">{evt.properties?.model_id ?? "—"}</td>
                <td className="py-2 text-right tabular-nums">
                  {evt.properties?.input_tokens ?? 0} / {evt.properties?.output_tokens ?? 0}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {Number(evt.value).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}