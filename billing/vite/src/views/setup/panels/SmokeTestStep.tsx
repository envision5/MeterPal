// billing/vite/src/views/setup/panels/SmokeTestStep.tsx
//
// The wizard's last step: one real, metered, billed call.
//
// Not a simulation -- the number shown is the number the end user was
// charged, read back from the usage event the gateway settled.

import { Button } from "@autumn/ui";
import { LightningIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { getBackendErr } from "@/utils/genUtils";
import type { SetupModel, SmokeTestResult } from "../hooks/useSetupState";

export function SmokeTestStep({
	models,
	result,
	lastRun,
	onRun,
	isRunning,
}: {
	models: SetupModel[];
	/** The result of the call the user just made, if any. */
	result: SmokeTestResult | null;
	/** The last recorded run, which survives a reload. */
	lastRun: { credits_charged: number | null; balance_after: number | null } | null;
	onRun: () => Promise<void>;
	isRunning: boolean;
}) {
	const enabled = models.filter((m) => m.enabled);
	// The chip names the model the test will actually call: the server picks
	// the first enabled model that has an upstream mapping (one without is not
	// routable by the gateway), falling back to the first enabled model.
	const defaultModel =
		enabled.find((m) => m.upstream_model) ?? enabled[0];

	const handleRun = async () => {
		try {
			await onRun();
		} catch (error) {
			toast.error(getBackendErr(error, "The test call failed"));
		}
	};

	if (enabled.length === 0) {
		return (
			<div className="rounded-lg border bg-interactive-secondary px-4 py-6 text-center">
				<p className="font-medium text-foreground text-sm">
					No model to call yet
				</p>
				<p className="mt-1 text-subtle text-xs">
					List a model on your price sheet first -- the test call bills
					exactly like your users' calls.
				</p>
			</div>
		);
	}

	const shown = result?.meterpal ?? lastRun;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-3">
				<Button
					variant="primary"
					size="sm"
					isLoading={isRunning}
					onClick={handleRun}
				>
					<LightningIcon size={12} weight="fill" className="mr-1.5" />
					Send a metered test call
				</Button>
				<span className="text-subtle text-xs">
					{defaultModel.display_name || defaultModel.model_id}
				</span>
			</div>

			{result && (
				<div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
					<p className="font-medium text-foreground text-sm">
						The call worked, and it cost{" "}
						<span className="tabular-nums">
							{result.meterpal.credits_charged ?? 0} credits
						</span>
					</p>
					<dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
						<div>
							<dt className="text-subtle">Tokens</dt>
							<dd className="tabular-nums text-foreground">
								{result.meterpal.input_tokens ?? 0} in ·{" "}
								{result.meterpal.output_tokens ?? 0} out
							</dd>
						</div>
						<div>
							<dt className="text-subtle">Balance left</dt>
							<dd className="tabular-nums text-foreground">
								{result.meterpal.balance_after ?? "—"}
							</dd>
						</div>
						<div>
							<dt className="text-subtle">Billed as</dt>
							<dd className="truncate text-foreground">
								{result.model_id}
							</dd>
						</div>
						<div>
							<dt className="text-subtle">End user</dt>
							<dd className="truncate text-foreground">
								{result.customer_id}
							</dd>
						</div>
					</dl>
					{result.reply && (
						<p className="mt-2 border-t border-border/50 pt-2 text-subtle text-xs">
							“{result.reply}”
						</p>
					)}
				</div>
			)}

			{!result && shown && (
				<p className="text-subtle text-xs">
					Your last test call cost {shown.credits_charged ?? 0} credits.
				</p>
			)}
		</div>
	);
}
