import type { Readable, Transform } from "node:stream";
import {
	type CustomerExportField,
	CustomerExportKind,
	type CustomerExportSnapshot,
} from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { createCustomerExportStringifier } from "../../csv/createCustomerExportStringifier.js";
import type { CustomerExportPopulation } from "../../queries/getCustomerExportScalars.js";
import type { CustomerExportProgressReporter } from "../customerExportProgressReporter.js";
import { createCustomerExportRowStream } from "./createCustomerExportRowStream.js";

export type CustomerExportRowStreamFactory = (args: {
	ctx: AutumnContext;
	snapshot: CustomerExportSnapshot;
	population: CustomerExportPopulation;
	progress?: CustomerExportProgressReporter;
	onPageProcessed: (page: {
		customerCount: number;
		rowCount: number;
	}) => Promise<void> | void;
}) => Readable;

export type CustomerExportProducer = {
	createRowStream: CustomerExportRowStreamFactory;
	createStringifier: (args: { fields: CustomerExportField[] }) => Transform;
};

/** The billing-verify export compared MeterPal's records against the
 *  processor's subscriptions. It has no producer, so the kind is absent. */
export const CUSTOMER_EXPORT_PRODUCERS: Partial<
	Record<CustomerExportKind, CustomerExportProducer>
> = {
	[CustomerExportKind.Customers]: {
		createRowStream: createCustomerExportRowStream,
		createStringifier: createCustomerExportStringifier,
	},
};
