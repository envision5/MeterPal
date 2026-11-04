import { useIsMobile } from "@autumn/ui";
import { SquareTerminal } from "lucide-react";
import { useMatch } from "react-router";
import { useWorkbenchStore } from "@/hooks/stores/useWorkbenchStore";
import { cn } from "@/lib/utils";
import { useAdmin } from "@/views/admin/hooks/useAdmin";
import { useSidebarContext } from "@/views/main-sidebar/SidebarContext";
import {
	sidebarIconClass,
	sidebarRowClass,
	sidebarRowContentClass,
} from "@/views/main-sidebar/sidebarRowClass";
import { useEnv } from "@/utils/envUtils";
import { getRedirectUrl } from "@/utils/genUtils";

export const WorkbenchButton = () => {
	const { isAdmin } = useAdmin();
	// Customer views are served under both the bare and the sandbox-prefixed
	// route tree (envRoutes), so match the pattern the current env actually
	// generates — a bare "/customers/..." match never hits "/sandbox/customers".
	const env = useEnv();
	const onCustomerView = useMatch(
		getRedirectUrl("/customers/:customer_id", env),
	);
	const onCustomerSubView = useMatch(
		getRedirectUrl("/customers/:customer_id/*", env),
	);
	const isMobile = useIsMobile();
	const { expanded } = useSidebarContext();

	const toggle = useWorkbenchStore((s) => s.toggle);
	const isOpen = useWorkbenchStore((s) => s.isOpen);

	if (!isAdmin || isMobile || (!onCustomerView && !onCustomerSubView)) {
		return null;
	}

	return (
		<button
			aria-label={expanded ? undefined : "Workbench"}
			title={expanded ? undefined : "Workbench"}
			type="button"
			onClick={(e) => {
				e.currentTarget.blur();
				toggle();
			}}
			className={sidebarRowClass({
				isActive: isOpen,
				isCollapsed: !expanded,
			})}
		>
			<div className={sidebarRowContentClass({ isCollapsed: !expanded })}>
				<div className={sidebarIconClass({ isActive: isOpen })}>
					<SquareTerminal strokeWidth={1.5} />
				</div>
				{expanded && (
					<span className="truncate whitespace-nowrap">Workbench</span>
				)}
			</div>
		</button>
	);
};
