// billing/vite/src/views/setup/panels/ModelsStep.tsx
//
// The wizard's price-sheet step.
//
// Shows the prices the merchant's users will actually pay, because the
// price sheet is the runtime authority: what it says is what gets charged.

import { Button } from "@autumn/ui";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import type { SetupModel } from "../hooks/useSetupState";

/** What one megabyte of tokens costs, for a quick sanity read. */
const formatCost = (value: number | null | undefined) => {
	if (value == null) return "—";
	return `$${value.toFixed(value < 1 ? 4 : 2)}`;
};

export function ModelsStep({ models }: { models: SetupModel[] }) {
	const navigate = useNavigate();
	const enabled = models.filter((m) => m.enabled);

	return (
		<div className="flex flex-col gap-3">
			{enabled.length === 0 ? (
				<div className="rounded-lg border bg-interactive-secondary px-4 py-6 text-center">
					<p className="font-medium text-foreground text-sm">
						No models on your price sheet
					</p>
					<p className="mt-1 text-subtle text-xs">
						Until you list a model, every model the gateway offers is
						priced by the provider. List the ones you want to sell and
						set your own price.
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{enabled.map((model) => (
						<div
							key={model.model_id}
							className="flex items-center gap-3 rounded-lg border bg-interactive-secondary px-4 py-3"
						>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate font-medium text-foreground text-sm">
									{model.display_name || model.model_id}
								</span>
								<span className="truncate text-tertiary-foreground text-xs">
									{model.model_id}
								</span>
							</div>
							<span className="shrink-0 text-subtle text-xs tabular-nums">
								{formatCost(model.input_cost_usd_1m)} in ·{" "}
								{formatCost(model.output_cost_usd_1m)} out
							</span>
						</div>
					))}
					<p className="text-subtle text-tiny">
						Prices are per million tokens, and they are yours to set.
					</p>
				</div>
			)}

			<Button
				variant="secondary"
				size="sm"
				className="self-start"
				onClick={() => navigate("/products?tab=models")}
			>
				Edit the price sheet
				<ArrowSquareOutIcon size={12} className="ml-1.5" />
			</Button>
		</div>
	);
}
