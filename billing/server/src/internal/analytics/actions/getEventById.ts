import { db as defaultDb } from "@/db/initDrizzle.js";
import { getClickhouseClient } from "@/external/tinybird/initClickhouse.js";
import { isTinybirdConfigured } from "@/external/tinybird/tinybirdUtils.js";
import { localGetEventById } from "@/internal/analytics/local/localPipes.js";

type EventRow = {
	id: string;
	org_id: string;
	env: string;
	customer_id: string;
	event_name: string;
	timestamp: string;
	value: string | null;
	properties: string | null;
	idempotency_key: string | null;
	entity_id: string | null;
};

/** Gets a single event by ID. Throws if not found. */
export const getEventById = async ({
	orgId,
	env,
	eventId,
	db,
}: {
	orgId: string;
	env: string;
	eventId: string;
	/** Optional pool override; defaults to the general pool. */
	db?: typeof defaultDb;
}): Promise<EventRow> => {
	// Without ClickHouse the event comes from the Postgres events table.
	if (!isTinybirdConfigured()) {
		return (await localGetEventById({
			db: db ?? defaultDb,
			orgId,
			env,
			eventId,
		})) as EventRow;
	}

	const ch = getClickhouseClient();

	const query = `
		SELECT *
		FROM events
		WHERE org_id = {org_id:String}
			AND env = {env:String}
			AND id = {event_id:String}
			AND timestamp > NOW() - INTERVAL '1 minute'
		LIMIT 1
	`;

	const result = await ch.query({
		query,
		query_params: {
			org_id: orgId,
			env,
			event_id: eventId,
		},
		format: "JSON",
	});

	const resultJson = (await result.json()) as { data: EventRow[] };

	if (resultJson.data.length === 0) {
		throw new Error(`Event not found: ${eventId}`);
	}

	return resultJson.data[0];
};
