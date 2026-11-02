// billing/server/src/internal/inference/inferenceErrors.ts
//
// The errors the inference proxy raises on its own behalf.
//
// The SDK maps them by HTTP status first and by code second, so the status
// is the contract and the code only disambiguates two errors that share a
// status (404: unknown model vs unknown customer).

import { RecaseError } from "@autumn/shared";

export const InferenceErrorCode = {
	/** The org has the model in its price sheet but has it switched off. */
	ModelNotEnabled: "model_not_enabled",
	/** The org does not serve this model at all. */
	ModelNotFound: "model_not_found",
	/** The gateway could not be reached, or answered with something unusable. */
	GatewayError: "gateway_error",
	/** A virtual-key call named a different end user than the key belongs to. */
	CustomerMismatch: "customer_mismatch",
	/** The request did not say which end user is being billed. */
	MissingCustomer: "missing_customer",
} as const;

export class ModelNotEnabledError extends RecaseError {
	constructor(opts: { model: string }) {
		super({
			message: `Model ${opts.model} is not enabled for this organization`,
			code: InferenceErrorCode.ModelNotEnabled,
			statusCode: 403,
		});
		this.name = "ModelNotEnabledError";
	}
}

export class ModelNotFoundError extends RecaseError {
	constructor(opts: { model: string }) {
		super({
			message: `Model ${opts.model} is not in this organization's served catalog`,
			code: InferenceErrorCode.ModelNotFound,
			statusCode: 404,
		});
		this.name = "ModelNotFoundError";
	}
}

export class GatewayError extends RecaseError {
	constructor(opts: { message: string; statusCode?: number }) {
		super({
			message: opts.message,
			code: InferenceErrorCode.GatewayError,
			statusCode: opts.statusCode ?? 502,
		});
		this.name = "GatewayError";
	}
}

export class CustomerMismatchError extends RecaseError {
	constructor(opts: { expected: string; received: string }) {
		super({
			message: `This credential is bound to customer ${opts.expected}, but the request billed ${opts.received}`,
			code: InferenceErrorCode.CustomerMismatch,
			statusCode: 403,
		});
		this.name = "CustomerMismatchError";
	}
}

export class MissingCustomerError extends RecaseError {
	constructor() {
		super({
			message:
				"No end user was billed for this request. Pass the end user's MeterPal customer id as `user`.",
			code: InferenceErrorCode.MissingCustomer,
			statusCode: 400,
		});
		this.name = "MissingCustomerError";
	}
}
