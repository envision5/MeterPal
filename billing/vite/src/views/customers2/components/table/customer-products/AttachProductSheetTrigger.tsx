import { Button } from "@autumn/ui";
import { PlusIcon } from "@phosphor-icons/react";
import {
	useIsAttachingProduct,
	useSheetStore,
} from "@/hooks/stores/useSheetStore";
import { cn } from "@/lib/utils";

export function AttachProductSheetTrigger() {
	const { setSheet } = useSheetStore();
	const isAttachingProduct = useIsAttachingProduct();

	const handleAttachClick = () => {
		setSheet({ type: "attach-product" });
	};

	return (
		<div
			className={cn(
				"flex items-center",
				isAttachingProduct && "z-90 opacity-70",
			)}
		>
			<Button
				variant="primary"
				size="mini"
				className="gap-1 font-medium"
				onClick={handleAttachClick}
			>
				<PlusIcon className="size-3.5" />
				Attach Plan
			</Button>
		</div>
	);
}
