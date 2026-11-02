// autumn/server/src/external/paypal/orders.ts
//
// Orders v2 wrapper: create / capture / refund.  Used for one-shot credit
// top-ups (1k / 5k / 25k packs).
//
// Every call goes through the ORG's PayPal client.

import type { PaypalClient } from "./paypalClient.js";

export interface OrderCreateArgs {
  intent: "CAPTURE" | "AUTHORIZE";
  purchase_units: Array<{
    reference_id?: string;
    custom_id?: string;
    description?: string;
    amount: {
      currency_code: string;
      value: string;
      breakdown?: { item_total?: { currency_code: string; value: string } };
    };
    items?: Array<{
      name: string;
      sku?: string;
      quantity: string;
      unit_amount: { currency_code: string; value: string };
      category?: "DIGITAL_GOODS" | "PHYSICAL_GOODS";
    }>;
  }>;
  payment_source?: {
    paypal?: {
      experience_context?: {
        shipping_preference?: string;
        user_action?: string;
        brand_name?: string;
        locale?: string;
      };
    };
  };
}

export interface OrderResponse {
  id: string;
  status: string;
  links: Array<{ href: string; rel: string; method?: string }>;
}

export async function createOrder(
  client: PaypalClient,
  args: OrderCreateArgs,
  opts: { idempotencyKey?: string } = {},
): Promise<OrderResponse> {
  return client.fetch<OrderResponse>("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify(args),
    idempotencyKey: opts.idempotencyKey,
  });
}

export async function captureOrder(
  client: PaypalClient,
  orderId: string,
): Promise<OrderResponse> {
  return client.fetch<OrderResponse>(
    `/v2/checkout/orders/${orderId}/capture`,
    {
      method: "POST",
      body: "{}",
      headers: { Prefer: "return=representation" },
    },
  );
}

export async function refundCapture(
  client: PaypalClient,
  captureId: string,
  amount?: { currency_code: string; value: string },
  note?: string,
): Promise<{ id: string; status: string }> {
  return client.fetch(`/v2/payments/captures/${captureId}/refund`, {
    method: "POST",
    body: JSON.stringify({
      amount,
      note_to_payer: note,
    }),
  });
}
