"use client";

import { useState } from "react";

export interface CostUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd: number;
  credits: number;
}

interface CostTooltipProps {
  usage: CostUsage;
}

/**
 * Inline cost badge with a hover popover that breaks down the per-request
 * token accounting. Renders as a single line of text; the popover appears
 * on hover/focus so screen-reader users can reach it via keyboard.
 */
export function CostTooltip({ usage }: CostTooltipProps) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-describedby="cost-breakdown"
        data-testid="cost-tooltip-trigger"
        className="cursor-help text-xs text-muted-foreground underline decoration-dotted rounded"
      >
        {usage.credits} credit{usage.credits === 1 ? "" : "s"}
      </button>
      {open && (
        <span
          id="cost-breakdown"
          role="tooltip"
          data-testid="cost-tooltip-popover"
          className="absolute bottom-full left-1/2 z-10 mb-2 w-72 -translate-x-1/2 rounded-md border border-border bg-background p-3 text-xs shadow-lg"
        >
          <span className="block font-semibold">{usage.model}</span>
          <span className="mt-1 block space-y-0.5">
            <span className="flex justify-between">
              <span>Input tokens</span>
              <span className="tabular-nums">{usage.input_tokens}</span>
            </span>
            <span className="flex justify-between">
              <span>Output tokens</span>
              <span className="tabular-nums">{usage.output_tokens}</span>
            </span>
            {(usage.cache_read_tokens ?? 0) > 0 && (
              <span className="flex justify-between text-emerald-600">
                <span>Cached reads</span>
                <span className="tabular-nums">{usage.cache_read_tokens}</span>
              </span>
            )}
            {(usage.cache_write_tokens ?? 0) > 0 && (
              <span className="flex justify-between text-amber-600">
                <span>Cache writes</span>
                <span className="tabular-nums">{usage.cache_write_tokens}</span>
              </span>
            )}
            <span className="flex justify-between border-t border-border pt-1 font-medium">
              <span>USD total</span>
              <span className="tabular-nums">${usage.cost_usd.toFixed(4)}</span>
            </span>
          </span>
        </span>
      )}
    </span>
  );
}