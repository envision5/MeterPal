import type {
	ApiEventsListItem,
	CursorPaginatedResponse,
	RawEventFromClickHouse,
} from "@autumn/shared";
import type { AxiosInstance } from "axios";
import { monthRangeWindow } from "../utils/monthRangeWindow";

/** Default page size, matching the row cap the tables were built around. */
export const EVENTS_LIST_PAGE_SIZE = 1000;

/** Keeps list consumers on the raw-event row shape they already render. */
const listItemToRawEvent = (
	item: ApiEventsListItem,
): RawEventFromClickHouse => ({
	id: item.id,
	timestamp: new Date(item.timestamp).toISOString(),
	event_name: item.feature_id,
	customer_id: item.customer_id,
	value: item.value,
	properties: JSON.stringify(item.properties ?? {}),
	// Carried through: it is the only thing that distinguishes a settled
	// charge from the reservation and release around it.
	idempotency_key: item.idempotency_key ?? null,
});

/**
 * True when the row is a billable charge.
 *
 * A metered call writes three events -- reserve, release, settle -- and only
 * the settle carries the call's idempotency key. The other two are internal
 * balance movements signed the wrong way to be a cost, and listing them as
 * "usage" gives a customer page full of phantom negatives. `undefined` means
 * the source could not say, so the row is kept rather than hiding a real
 * charge.
 */
export const isChargeEvent = (event: {
	idempotency_key?: string | null;
}): boolean => event.idempotency_key !== null;

/** Callers pass an axios instance pinned to LATEST_VERSION for cursor paging. */
export const fetchEventsList = async ({
	axiosInstance,
	customerId,
	entityId,
	featureIds,
	interval,
	binSize = "day",
	customRange,
	limit = EVENTS_LIST_PAGE_SIZE,
	startCursor,
	/** Drop reservations and their release; keep settled charges only. */
	chargesOnly = false,
}: {
	axiosInstance: AxiosInstance;
	customerId?: string | null;
	entityId?: string | null;
	featureIds?: string[];
	interval: string;
	binSize?: string;
	customRange?: { start: number; end: number };
	limit?: number;
	startCursor?: string;
	chargesOnly?: boolean;
}): Promise<{
	events: RawEventFromClickHouse[];
	nextCursor: string | null;
}> => {
	const window = customRange ?? monthRangeWindow({ interval, binSize });
	const { data } = await axiosInstance.post<
		CursorPaginatedResponse<ApiEventsListItem>
	>("/v1/events.list", {
		customer_id: customerId || undefined,
		entity_id: entityId || undefined,
		feature_id: featureIds?.length ? featureIds : undefined,
		...(window ? { custom_range: window } : { range: interval }),
		limit,
		start_cursor: startCursor,
	});

	const events = data.list.map(listItemToRawEvent);

	return {
		events: chargesOnly ? events.filter(isChargeEvent) : events,
		nextCursor: data.next_cursor,
	};
};
