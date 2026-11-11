import * as react from 'react';
import { IAutumnClient } from 'autumn-js/react';

interface CreditsBadgeProps {
    featureId?: string;
    /** Refresh interval in ms.  Default 5000 (5s). */
    pollIntervalMs?: number;
}
declare function CreditsBadge({ featureId, pollIntervalMs, }: CreditsBadgeProps): react.JSX.Element;

interface LowBalanceBannerProps {
    featureId?: string;
    thresholds?: {
        warn: number;
        danger: number;
    };
    onAddCredits?: () => void;
}
declare function LowBalanceBanner({ featureId, thresholds, onAddCredits, }: LowBalanceBannerProps): react.JSX.Element | null;

declare function PlanCard(): react.JSX.Element;

interface TopUpModalProps {
    /** Top-up product ids, ordered small → large.  Configure in your MeterPal catalog. */
    productIds?: string[];
    /** Human-readable labels for each product (matched by index). */
    labels?: string[];
    /** Prices in USD (matched by index). */
    prices?: number[];
    /**
     * Optional poll callback for popup checkout: called every few seconds while
     * the PayPal popup is open.  Return `{ captured: true }` once the payment
     * has been captured server-side.  When provided, checkout opens in a popup
     * and this modal closes itself on capture — no page redirect.  When
     * omitted, checkout redirects the current tab (relies on PayPal's
     * return_url redirect).
     */
    pollFinalize?: () => Promise<{
        captured: boolean;
        credits?: number;
    } | null>;
    /** Fired after a payment is confirmed captured (popup mode only). */
    onCaptured?: (credits?: number) => void;
    /**
     * In-page PayPal Buttons mode (recommended): the PayPal JS SDK renders its
     * buttons inside this modal — no redirect and no host-managed popup, so the
     * app page never navigates away.  `capture` is called from onApprove with
     * the order id; return `{ captured: true }` once the server has captured
     * and credited the wallet.
     */
    inPageCheckout?: {
        clientId: string;
        /** Resolve with `{ captured: true }` once the server has captured and
         *  credited the wallet.  The billing server's native shape
         *  `{ status: "captured", credits }` is accepted too. */
        capture: (orderId: string) => Promise<{
            captured: boolean;
            credits?: number;
            status?: string;
        }>;
    };
}
declare function TopUpModal({ productIds, labels, prices, pollFinalize, onCaptured, inPageCheckout, }: TopUpModalProps): react.JSX.Element | null;

interface UsageHistoryPanelProps {
    featureId?: string;
    /** Start of the usage window. Defaults to the first day of the current month. */
    rangeStart?: Date;
    /** End of the usage window. Defaults to now. */
    rangeEnd?: Date;
    /** Max events to fetch. Default 50. */
    limit?: number;
}
/**
 * Usage history for the current customer (identity resolved server-side by
 * the autumn-js backend adapter): per-model credit totals for the window,
 * plus the most recent metered requests.
 */
declare function UsageHistoryPanel({ featureId, rangeStart, rangeEnd, limit, }: UsageHistoryPanelProps): react.JSX.Element;

interface CostUsage {
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
declare function CostTooltip({ usage }: CostTooltipProps): react.JSX.Element;

type CurrentPlan = {
    /** The plan id the customer is on, e.g. "pro". Null when they are on none. */
    planId: string | null;
    /** The plan's display name, e.g. "MeterPal Pro". Null when unknown. */
    name: string | null;
    /** True until the customer and the plan list have both resolved. */
    isLoading: boolean;
};
/** The plan id from a customer payload, preferring the active subscription. */
declare function currentPlanIdOf(customer: any): string | null;
declare function useCurrentPlan(): CurrentPlan;

/**
 * Customer-safe client factory for MeterPal billing.
 *
 * The client talks to routes mounted in the HOST APP's backend via the
 * `autumn-js/backend` adapters (express / hono / next / fetch).  The backend
 * injects the secret key — no API key ever ships to the browser:
 *
 *   // your app's server (e.g. Next.js route handler / express):
 *   import { autumnBackend } from "autumn-js/backend";
 *   app.use("/api/autumn", autumnBackend({ secretKey: process.env.METERPAL_SECRET_KEY! }));
 *
 *   // your app's client:
 *   import { createMeterPalClient } from "@meterpal/sdk";
 *   const billing = createMeterPalClient({ backendUrl: "" }); // same-origin
 *   const customer = await billing.getOrCreateCustomer({ customer_id: "cus_123" });
 */

interface MeterPalClientConfig {
    /** Base URL of the backend that mounts the autumn-js/backend routes. Same-origin = "". */
    backendUrl: string;
    /** Route prefix the backend mounted the billing routes under. Default "/api/autumn". */
    pathPrefix?: string;
    includeCredentials?: boolean;
    headers?: Record<string, string>;
}
type MeterPalClient = IAutumnClient;
declare function createMeterPalClient(cfg: MeterPalClientConfig): MeterPalClient;
/** @deprecated use {@link createMeterPalClient} */
declare const createBillingClient: typeof createMeterPalClient;

/**
 * The shapes the MeterPal inference API speaks.
 *
 * The response is the OpenAI shape verbatim -- only `meterpal` is added --
 * so anything that already understands OpenAI can read it unchanged.
 */
type ChatRole = "system" | "user" | "assistant" | "tool" | "function" | "developer";
type ChatMessage = {
    role: ChatRole;
    content?: string | Array<Record<string, unknown>> | null;
    name?: string;
    tool_call_id?: string;
    [key: string]: unknown;
};
type ChatCompletionRequest = {
    /** A model id from the merchant's served catalog. */
    model: string;
    messages: ChatMessage[];
    /** The end user being billed — their MeterPal customer id. */
    user?: string;
    stream?: boolean;
    max_tokens?: number;
    max_completion_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    [key: string]: unknown;
};
type Usage = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    [key: string]: unknown;
};
/** What the call cost, added to every MeterPal response. */
type MeterpalBlock = {
    /** Credits the call cost. Null when the charge could not be read back. */
    credits_charged: number | null;
    /** The end user's spendable balance after the call. */
    balance_after: number | null;
    customer_id: string;
    /** The model id the charge was recorded against. */
    model_id: string | null;
    /**
     * Prompt tokens as the provider counted them, cached input included.
     * `input_tokens * input_rate + output_tokens * output_rate` reproduces
     * `credits_charged`.
     */
    input_tokens: number | null;
    /** Completion tokens as the provider counted them, reasoning included. */
    output_tokens: number | null;
    /** The part of `input_tokens` served from the provider's prompt cache. */
    cache_read_tokens?: number | null;
    /** The part of `input_tokens` written to the prompt cache. */
    cache_write_tokens?: number | null;
    /** The part of `output_tokens` the model spent reasoning. */
    reasoning_tokens?: number | null;
};
type ChatCompletionChoice = {
    index: number;
    message: {
        role: string;
        content: string | null;
        [key: string]: unknown;
    };
    finish_reason: string | null;
    [key: string]: unknown;
};
type ChatCompletion = {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage: Usage;
    meterpal: MeterpalBlock;
    [key: string]: unknown;
};
type ChatCompletionChunkChoice = {
    index: number;
    delta: {
        role?: string;
        content?: string | null;
        [key: string]: unknown;
    };
    finish_reason: string | null;
    [key: string]: unknown;
};
type ChatCompletionChunk = {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: ChatCompletionChunkChoice[];
    usage?: Usage;
    /** Present on the final chunk, when the call was billed. */
    meterpal?: MeterpalBlock;
    [key: string]: unknown;
};
type ServedModel = {
    model_id: string;
    display_name: string | null;
    upstream_model: string | null;
    enabled: boolean;
    input_cost_usd_1m: number | null;
    output_cost_usd_1m: number | null;
    markup_pct: number | null;
    [key: string]: unknown;
};
type Catalog = {
    org_id: string;
    env: string;
    models: ServedModel[];
    /** Null means the merchant serves every model the gateway offers. */
    allowed_model_ids: string[] | null;
};
/** A PayPal checkout the end user can pay. */
type TopUpResult = {
    /** The URL to send the end user to. */
    url: string;
    /** The checkout id, when the API returned one. */
    id?: string;
};

/**
 * The MeterPal inference client.
 *
 * An OpenAI-shaped client that bills the end user for every call:
 *
 *   const meterpal = createMeterPal({ apiKey: process.env.METERPAL_SECRET_KEY });
 *
 *   const completion = await meterpal.chat.completions.create({
 *     model: "custom/demo-gpt",
 *     messages: [{ role: "user", content: "hi" }],
 *     user: "cus_123",       // the end user being billed
 *   });
 *
 *   completion.meterpal.credits_charged;   // what it cost
 *
 * The secret key stays on the server.  The client mints a per-customer
 * virtual key on first use and caches it, so the merchant's app never has to
 * think about credentials again.
 */

declare const DEFAULT_BASE_URL = "https://api.meterpal.dev";
type FetchLike = (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<Response>;
type TopUpOptions = {
    /** The product to charge for. Defaults to the merchant's top-up plan. */
    productId?: string;
    /** Where PayPal sends the end user back to. */
    returnUrl?: string;
    /** How many credits the end user is buying. */
    credits?: number;
};
interface MeterPalConfig {
    /**
     * The merchant's MeterPal secret key (server-side only), or a customer
     * virtual key to bill one specific end user.
     */
    apiKey: string;
    /** The MeterPal API. Defaults to https://api.meterpal.dev */
    baseURL?: string;
    /** A custom fetch, for tests or a proxy. */
    fetch?: FetchLike;
    /**
     * Create the end user the first time they are billed.
     *
     * Defaults to true: the merchant should not have to create a customer
     * before their users can chat.  The new customer starts with no credits,
     * so the first call is answered with the paywall.
     */
    autoCreateCustomer?: boolean;
    /** How long to wait for the API, in milliseconds. Defaults to 120s. */
    timeoutMs?: number;
    /** Extra headers on every request. */
    headers?: Record<string, string>;
}
type MeterPal = {
    chat: {
        completions: {
            /** Run one completion and bill the end user. */
            create(params: ChatCompletionRequest): Promise<ChatCompletion>;
            /** Run one completion as a stream of chunks. */
            stream(params: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown>;
        };
    };
    keys: {
        /** Mint (or fetch) the gateway credential for one end user. */
        provision(customerId: string): Promise<{
            key: string;
            customer_id: string;
            created: boolean;
        }>;
    };
    models: {
        /** The models this merchant serves, with their prices. */
        list(): Promise<Catalog>;
    };
};
declare function createMeterPal(config: MeterPalConfig): MeterPal;

declare function formatCredits(n: number): string;
/**
 * Balance lookup tolerant to both adapter shapes:
 *   dict keyed by feature id (autumn-js backend adapter, camelCase fields)
 *   array of {feature_id | featureId, ...} (raw server shape)
 */
declare function findCustomerBalance(customer: any, featureId: string): {
    remaining: number;
    granted: number;
    unlimited: boolean;
} | null;

/**
 * The errors the inference client raises.
 *
 * Each one carries the next action: a 402 knows how to open a PayPal
 * checkout, a 403 knows which model was refused.  The paywall is the point
 * of the product, so it gets first-class support rather than a raw HTTP
 * failure.
 */

type MeterPalErrorOptions = {
    status?: number;
    code?: string;
    body?: unknown;
    cause?: unknown;
};
declare class MeterPalError extends Error {
    readonly status?: number;
    readonly code?: string;
    readonly body?: unknown;
    constructor(message: string, options?: MeterPalErrorOptions);
}
/** The MeterPal secret key was rejected. */
declare class AuthenticationError extends MeterPalError {
    constructor(message?: string, options?: MeterPalErrorOptions);
}
/**
 * The end user cannot pay for this call.
 *
 * `topUp()` opens the PayPal checkout, so the caller does not have to know
 * how MeterPal takes payments.
 */
declare class InsufficientBalanceError extends MeterPalError {
    /** The end user who needs to pay. */
    customerId?: string;
    /** Their spendable balance, in credits. */
    balance?: number;
    /** The smallest balance that would have let the call through. */
    requiredCredits?: number;
    /**
     * Open the PayPal checkout.
     *
     * Assigned by the client, which knows how to create a checkout for this
     * merchant.  Returns the URL to send the end user to.
     */
    topUp?: (options?: {
        productId?: string;
        returnUrl?: string;
        credits?: number;
    }) => Promise<TopUpResult>;
    constructor(message?: string, options?: MeterPalErrorOptions & {
        customerId?: string;
        balance?: number;
        requiredCredits?: number;
    });
}
/** The merchant does not serve this model. */
declare class ModelNotEnabledError extends MeterPalError {
    readonly model?: string;
    constructor(message?: string, options?: MeterPalErrorOptions & {
        model?: string;
    });
}
/** The merchant has never heard of this model. */
declare class ModelNotFoundError extends MeterPalError {
    readonly model?: string;
    constructor(message?: string, options?: MeterPalErrorOptions & {
        model?: string;
    });
}
/** The end user's plan limit was reached. */
declare class RateLimitError extends MeterPalError {
    constructor(message?: string, options?: MeterPalErrorOptions);
}
/** The end user does not exist in this organization. */
declare class CustomerNotFoundError extends MeterPalError {
    readonly customerId?: string;
    constructor(message?: string, options?: MeterPalErrorOptions & {
        customerId?: string;
    });
}
/** The API answered with something the client cannot use. */
declare class APIError extends MeterPalError {
    constructor(message?: string, options?: MeterPalErrorOptions);
}
/** The API could not be reached. */
declare class ConnectionError extends MeterPalError {
    constructor(message?: string, options?: MeterPalErrorOptions);
}

export { APIError, AuthenticationError, type MeterPalClientConfig as BillingClientConfig, type Catalog, type ChatCompletion, type ChatCompletionChoice, type ChatCompletionChunk, type ChatCompletionChunkChoice, type ChatCompletionRequest, type ChatMessage, type ChatRole, ConnectionError, CostTooltip, CreditsBadge, type CurrentPlan, CustomerNotFoundError, DEFAULT_BASE_URL, type FetchLike, InsufficientBalanceError, LowBalanceBanner, type MeterPal, type MeterPalClient, type MeterPalClientConfig, type MeterPalConfig, MeterPalError, type MeterpalBlock, ModelNotEnabledError, ModelNotFoundError, PlanCard, RateLimitError, type ServedModel, TopUpModal, type TopUpOptions, type TopUpResult, type Usage, UsageHistoryPanel, createBillingClient, createMeterPal, createMeterPalClient, currentPlanIdOf, findCustomerBalance, formatCredits, useCurrentPlan };
