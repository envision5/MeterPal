import type { ApiEventsListItem } from "@autumn/shared";
import type { AxiosError } from "axios";
import { useState } from "react";
import { getBackendErr } from "@/utils/genUtils";
import { UsagePageHeader } from "@/views/customers/customer/analytics/components/UsagePageHeader";
import { LogDetailPane } from "./components/LogDetailPane";
import { LogsList } from "./components/LogsList";
import { LogsToolbar } from "./components/LogsToolbar";
import { LogsVolumeStrip } from "./components/LogsVolumeStrip";
import { useLogsEvents } from "./hooks/useLogsEvents";
import { useLogsFilters } from "./hooks/useLogsFilters";

/** Logs tab of the Usage page: every tracked event, newest first. */
export const LogsView = () => {
	const {
		events,
		isLoading,
		error,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useLogsEvents();
	const [selected, setSelected] = useState<ApiEventsListItem | null>(null);

	// The analytics backend can be absent (self-hosted without Tinybird) —
	// that is a configuration state, not a failed request, so it gets its own
	// empty state rather than an error line.
	const analyticsNotConfigured =
		(error as AxiosError | undefined)?.response?.data?.code ===
		"analytics_not_configured";

	// Drop the open event once the list it came from is filtered away.
	const { filters } = useLogsFilters();
	const filterKey = JSON.stringify([
		filters.feature_id,
		filters.customer_id,
		filters.range,
		filters.properties,
	]);
	const [selectedFilterKey, setSelectedFilterKey] = useState(filterKey);
	if (selectedFilterKey !== filterKey) {
		setSelectedFilterKey(filterKey);
		setSelected(null);
	}

	return (
		<div className="flex flex-col h-full min-h-0 w-full text-sm">
			{/* Same box as PageContainer on the Overview tab, so the header lines up. */}
			<div className="w-full max-w-[1600px] mx-auto pt-4 sm:pt-8 px-4 sm:px-10 shrink-0">
				<UsagePageHeader activeTab="logs" />
			</div>
			<LogsToolbar />
			<div className="px-4 pt-3.5 pb-2.5 shrink-0 border-b">
				<LogsVolumeStrip />
			</div>
			{error ? (
				analyticsNotConfigured ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm">
						<p className="text-muted-foreground">
							Usage analytics isn't connected on this server.
						</p>
						<p className="text-muted-foreground text-xs">
							Events will appear here once the analytics backend is
							configured.
						</p>
					</div>
				) : (
					<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
						Couldn't load events. {getBackendErr(error, error.message)}
					</div>
				)
			) : (
				<div className="flex flex-1 min-h-0">
					<LogsList
						events={events}
						isLoading={isLoading}
						hasNextPage={hasNextPage}
						isFetchingNextPage={isFetchingNextPage}
						fetchNextPage={fetchNextPage}
						selectedId={selected?.id ?? null}
						onSelect={setSelected}
					/>
					{selected && (
						<LogDetailPane event={selected} onClose={() => setSelected(null)} />
					)}
				</div>
			)}
		</div>
	);
};
