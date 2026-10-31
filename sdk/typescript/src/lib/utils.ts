import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCredits(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
/**
 * Balance lookup tolerant to both adapter shapes:
 *   dict keyed by feature id (autumn-js backend adapter, camelCase fields)
 *   array of {feature_id | featureId, ...} (raw server shape)
 */
export function findCustomerBalance(
  customer: any,
  featureId: string,
): { remaining: number; granted: number; unlimited: boolean } | null {
  if (!customer) return null;
  const balances = customer.balances;
  if (!balances) return null;
  const bal = Array.isArray(balances)
    ? balances.find(
        (b: any) => (b.feature_id ?? b.featureId ?? b.feature?.id) === featureId,
      )
    : balances[featureId];
  if (!bal) return null;
  return {
    remaining: Number(bal.remaining ?? 0),
    granted: Number(bal.granted ?? bal.max ?? 0),
    unlimited: Boolean(bal.unlimited),
  };
}
