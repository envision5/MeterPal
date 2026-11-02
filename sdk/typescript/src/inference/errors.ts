/**
 * The errors the inference client raises.
 *
 * Each one carries the next action: a 402 knows how to open a PayPal
 * checkout, a 403 knows which model was refused.  The paywall is the point
 * of the product, so it gets first-class support rather than a raw HTTP
 * failure.
 */

import type { TopUpResult } from "./types";

export type MeterPalErrorOptions = {
	status?: number;
	code?: string;
	body?: unknown;
	cause?: unknown;
};

export class MeterPalError extends Error {
	readonly status?: number;
	readonly code?: string;
	readonly body?: unknown;

	constructor(message: string, options: MeterPalErrorOptions = {}) {
		super(message);
		this.name = "MeterPalError";
		this.status = options.status;
		this.code = options.code;
		this.body = options.body;
		if (options.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}

/** The MeterPal secret key was rejected. */
export class AuthenticationError extends MeterPalError {
	constructor(message = "Invalid MeterPal secret key", options: MeterPalErrorOptions = {}) {
		super(message, options);
		this.name = "AuthenticationError";
	}
}

/**
 * The end user cannot pay for this call.
 *
 * `topUp()` opens the PayPal checkout, so the caller does not have to know
 * how MeterPal takes payments.
 */
export class InsufficientBalanceError extends MeterPalError {
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

	constructor(
		message = "The customer does not have enough credits for this call",
		options: MeterPalErrorOptions & {
			customerId?: string;
			balance?: number;
			requiredCredits?: number;
		} = {},
	) {
		super(message, options);
		this.name = "InsufficientBalanceError";
		this.customerId = options.customerId;
		this.balance = options.balance;
		this.requiredCredits = options.requiredCredits;
	}
}

/** The merchant does not serve this model. */
export class ModelNotEnabledError extends MeterPalError {
	readonly model?: string;
	constructor(
		message = "This model is not enabled for this organization",
		options: MeterPalErrorOptions & { model?: string } = {},
	) {
		super(message, options);
		this.name = "ModelNotEnabledError";
		this.model = options.model;
	}
}

/** The merchant has never heard of this model. */
export class ModelNotFoundError extends MeterPalError {
	readonly model?: string;
	constructor(
		message = "This model is not in the organization's served catalog",
		options: MeterPalErrorOptions & { model?: string } = {},
	) {
		super(message, options);
		this.name = "ModelNotFoundError";
		this.model = options.model;
	}
}

/** The end user's plan limit was reached. */
export class RateLimitError extends MeterPalError {
	constructor(message = "Rate limit exceeded", options: MeterPalErrorOptions = {}) {
		super(message, options);
		this.name = "RateLimitError";
	}
}

/** The end user does not exist in this organization. */
export class CustomerNotFoundError extends MeterPalError {
	readonly customerId?: string;
	constructor(
		message = "No such customer in this organization",
		options: MeterPalErrorOptions & { customerId?: string } = {},
	) {
		super(message, options);
		this.name = "CustomerNotFoundError";
		this.customerId = options.customerId;
	}
}

/** The API answered with something the client cannot use. */
export class APIError extends MeterPalError {
	constructor(message = "MeterPal request failed", options: MeterPalErrorOptions = {}) {
		super(message, options);
		this.name = "APIError";
	}
}

/** The API could not be reached. */
export class ConnectionError extends MeterPalError {
	constructor(message = "Could not reach MeterPal", options: MeterPalErrorOptions = {}) {
		super(message, options);
		this.name = "ConnectionError";
	}
}
