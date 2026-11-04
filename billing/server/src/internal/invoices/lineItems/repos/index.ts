import { deleteByInvoiceId } from "./deleteByInvoiceId";
import { getByCustomerProductAndPeriod } from "./getByCustomerProductAndPeriod";
import { getByCustomerProductIds } from "./getByCustomerProductIds";
import { getByInvoiceId } from "./getByInvoiceId";
import { getByInvoiceIds } from "./getByInvoiceIds";
import { insertMany } from "./insertMany";
import { reconcileMany } from "./reconcileMany";
import { upsertMany } from "./upsertMany";

export const invoiceLineItemRepo = {
	insertMany,
	upsertMany,
	reconcileMany,
	getByInvoiceId,
	getByInvoiceIds,
	getByCustomerProductAndPeriod,
	getByCustomerProductIds,
	deleteByInvoiceId,
};
