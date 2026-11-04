import type { DbCustomerExport } from "@autumn/shared";
import { ErrCode, RecaseError } from "@autumn/shared";
import type { CustomerExportDestination } from "@/external/aws/s3/customerExportsS3Config.js";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import type { CustomerExportPopulation } from "../../queries/getCustomerExportScalars.js";
import type { CustomerExportProgressReporter } from "../customerExportProgressReporter.js";
import { CUSTOMER_EXPORT_PRODUCERS } from "./customerExportProducers.js";
import { uploadCustomerExportCsvStream } from "./uploadCustomerExportCsvStream.js";

export const streamCustomerExportCsv = async ({
	ctx,
	customerExport,
	population,
	destination,
	progress,
	onCustomersProcessed,
}: {
	ctx: AutumnContext;
	customerExport: DbCustomerExport;
	population: CustomerExportPopulation;
	destination: CustomerExportDestination;
	progress?: CustomerExportProgressReporter;
	onCustomersProcessed?: (customerCount: number) => Promise<void> | void;
}): Promise<{ rowCount: number; byteCount: number }> => {
	const { kind, fields, snapshot } = customerExport;
	const producer = CUSTOMER_EXPORT_PRODUCERS[kind];
	if (!producer) {
		throw new RecaseError({
			message: `Unsupported customer export kind: ${kind}`,
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}
	const { createRowStream, createStringifier } = producer;
	let rowCount = 0;

	const rows = createRowStream({
		ctx,
		snapshot,
		population,
		progress,
		onPageProcessed: async (page) => {
			rowCount += page.rowCount;
			await onCustomersProcessed?.(page.customerCount);
		},
	});

	const { byteCount } = await uploadCustomerExportCsvStream({
		rows,
		stringifier: createStringifier({ fields }),
		destination,
	});

	return { rowCount, byteCount };
};
