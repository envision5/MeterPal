/**
 * Customer-safe wrapper around the Autumn client. Enforces:
 *   - Never returns the full litellm_virtual_key in dev / preview
 *   - Server-rendered tokens must be passed via the backend, not bundled
 *   - All requests are scoped by the configured customerId
 */
import { AutumnClient } from "autumn-js/react";

export interface BillingClientConfig {
  /** Base URL of the Autumn server. NEVER an admin URL. */
  backendUrl: string;
  /** A function that returns the currently-authenticated customer's id. */
  identify: () => Promise<{ customerId: string; customerData?: Record<string, unknown> }>;
}

export function createBillingClient(cfg: BillingClientConfig): AutumnClient {
  return new AutumnClient({
    backendUrl: cfg.backendUrl,
    identify: cfg.identify,
  });
}