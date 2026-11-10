import type { ReactNode } from "react";
import {
	MeterPalMark,
	MeterPalWordmark,
} from "@/components/general/MeterPalWordmark";

/**
 * MeterPal branding pinned above the org switcher at the top of the sidebar.
 * It is the dashboard's only product mark, so it has to read as app identity
 * rather than as one more nav row.
 *
 * The wordmark is ~4.9:1. It used to span the rail's full 168px content box
 * (~35px tall), which left no room beside it, so the expand/collapse button
 * had to float over the top-right corner and the wordmark was pushed down to
 * clear it. The wordmark now renders at 28px tall (~136px wide) so the toggle
 * can ride inline at the right end of the same row — that is the `trailing`
 * slot. The 52px collapsed rail can't hold the wordmark, so collapsed falls
 * back to the square mark — and since the rail has no toggle button either,
 * the mark itself is the way back out (`onExpand`). Without it, a collapsed
 * sidebar could only be reopened from the thin hover strip on the edge.
 *
 * Every asset here is generated from assets/images/ by
 * scripts/sync-brand-assets.mjs — never hand-edited at those public paths.
 */
export function SidebarBrand({
	expanded,
	trailing,
	onExpand,
}: {
	expanded: boolean;
	trailing?: ReactNode;
	/** Collapsed rail only: the mark doubles as the expand control. */
	onExpand?: () => void;
}) {
	if (!expanded) {
		const mark = (
			<MeterPalMark className="size-6 select-none" draggable={false} />
		);

		return (
			<div className="flex justify-center">
				{onExpand ? (
					<button
						type="button"
						onClick={onExpand}
						aria-label="Expand sidebar"
						title="Expand sidebar"
						className="-m-1 cursor-pointer rounded-md p-1 transition-opacity outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						{mark}
					</button>
				) : (
					mark
				)}
			</div>
		);
	}

	return (
		<div className="flex items-center justify-between gap-2 px-1.5">
			<MeterPalWordmark className="h-7 w-auto select-none" draggable={false} />
			{trailing}
		</div>
	);
}
