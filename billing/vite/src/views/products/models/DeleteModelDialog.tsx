import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@autumn/ui";
import type { ServedModel } from "@/hooks/queries/useServedModelsQuery";

/**
 * Deleting a model takes it off the price sheet and out of the allow-list
 * the gateway enforces, so it asks first -- and it says what the instances
 * go with it.
 */
export const DeleteModelDialog = ({
	model,
	open,
	onOpenChange,
	onConfirm,
	isDeleting,
}: {
	model: ServedModel | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	isDeleting: boolean;
}) => {
	const instanceCount = model?.deployments?.length ?? 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="truncate">
						Remove {model?.display_name || model?.model_id}
					</DialogTitle>
					<DialogDescription>
						{model?.model_id} comes off your price sheet and your users stop
						being able to call it.
						{instanceCount > 0 &&
							` Its ${instanceCount === 1 ? "instance" : "instances"} go with it. `}
						This action cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						variant="secondary"
						onClick={() => onOpenChange(false)}
						disabled={isDeleting}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={onConfirm}
						isLoading={isDeleting}
					>
						Remove model
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
