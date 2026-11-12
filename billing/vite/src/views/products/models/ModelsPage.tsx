// billing/vite/src/views/products/models/ModelsPage.tsx
//
// The merchant's price sheet: which models they serve, and what they charge.
//
// The prices shown here are the MERCHANT's prices.  They become the runtime
// authority the moment they are saved: a change in the provider's price
// cannot move them afterwards.
//
// The page reads, and the sheet writes.  Editing a price here is a two-step
// affair on purpose -- pick a model, then set what it costs in the editor --
// because the price, the markup, the display name and the gateway name all
// belong to one row, and a row edited field-by-field in place is a row that
// can be left half-configured.

import { Button, Input, Skeleton, Switch } from "@autumn/ui";
import { TrashIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type AvailableModel,
	type DeploymentUpdate,
	type ServedModel,
	useServedModelsQuery,
} from "@/hooks/queries/useServedModelsQuery";
import { getBackendErr } from "@/utils/genUtils";
import {
	SETTINGS_LIST_CLASS,
	SettingsGroup,
} from "@/views/settings/components/SettingsGroup";
import {
	type DeploymentCreateValues,
	DeploymentsSection,
} from "./DeploymentsSection";
import { DeleteModelDialog } from "./DeleteModelDialog";
import { type ModelSheetTarget, ModelSheet } from "./ModelSheet";
import {
	baseInputPrice,
	baseOutputPrice,
	formatUsd,
	marginPct,
	markupLabel,
	markupSourceLabel,
	withMarkup,
} from "./modelPricing";

/** One labelled number in a model's stat strip. */
const Stat = ({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint?: string;
}) => (
	<div className="flex flex-col gap-0.5">
		<span className="text-subtle text-tiny">{label}</span>
		<span className="font-medium text-foreground text-sm">{value}</span>
		{hint && <span className="text-subtle text-tiny">{hint}</span>}
	</div>
);

const ServedModelCard = ({
	model,
	catalogEntry,
	providerInput,
	providerOutput,
	onEdit,
	onToggle,
	onRemove,
	onCreateDeployment,
	onUpdateDeployment,
	onRemoveDeployment,
	isDeploymentBusy,
}: {
	model: ServedModel;
	/** The catalog's view of this model, when it has one: what a new
	 *  instance starts from. */
	catalogEntry: AvailableModel | undefined;
	providerInput: number | null;
	providerOutput: number | null;
	onEdit: () => void;
	onToggle: (enabled: boolean) => void;
	onRemove: () => void;
	onCreateDeployment: (values: DeploymentCreateValues) => Promise<void>;
	onUpdateDeployment: (
		deploymentId: string,
		values: DeploymentUpdate,
	) => Promise<void>;
	onRemoveDeployment: (deploymentId: string) => Promise<void>;
	isDeploymentBusy: boolean;
}) => {
	/**
	 * A row states a price for both directions or for neither: half a price
	 * is "no opinion" to the runtime, and the provider's price applies then.
	 */
	const ownPriced =
		model.input_cost_usd_1m != null && model.output_cost_usd_1m != null;

	const baseInput = ownPriced
		? model.input_cost_usd_1m
		: baseInputPrice(null, providerInput);
	const baseOutput = ownPriced
		? model.output_cost_usd_1m
		: baseOutputPrice(null, providerOutput);

	// The markup the server resolved, the same one the request path charges.
	const markup = model.effective_markup_pct;
	const effectiveInput = withMarkup(baseInput, markup);
	const effectiveOutput = withMarkup(baseOutput, markup);
	const margin = marginPct(effectiveInput, providerInput);

	return (
		<div
			className={`flex flex-col gap-3 px-4 py-3.5 ${model.enabled ? "" : "opacity-60"}`}
		>
			<div className="flex items-center gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate font-medium text-foreground text-sm">
						{model.display_name || model.model_id}
					</span>
					<span className="truncate text-tertiary-foreground text-xs">
						{model.model_id}
						{providerInput != null && (
							<span className="ml-2 text-subtle">
								provider {formatUsd(providerInput)} /{" "}
								{formatUsd(providerOutput)}
							</span>
						)}
					</span>
				</div>

				<span className="shrink-0 font-medium text-subtle text-xs">
					{model.enabled ? "Served" : "Off"}
				</span>
				<Switch
					checked={model.enabled}
					onCheckedChange={onToggle}
					aria-label={`Serve ${model.model_id}`}
				/>
				<Button
					variant="secondary"
					size="sm"
					className="shrink-0"
					onClick={onEdit}
				>
					Edit
				</Button>
				<Button
					variant="muted"
					size="sm"
					className="shrink-0"
					onClick={onRemove}
					aria-label={`Remove ${model.model_id}`}
				>
					<TrashIcon className="size-3.5" />
				</Button>
			</div>

			<div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
				<Stat
					label="PRICE $/1M"
					value={`${formatUsd(baseInput)} / ${formatUsd(baseOutput)}`}
					hint={ownPriced ? "yours" : "the provider's"}
				/>
				<Stat
					label="MARKUP"
					value={markupLabel({
						source: model.effective_markup_source,
						effectivePct: model.effective_markup_pct,
					})}
					hint={markupSourceLabel(model.effective_markup_source)}
				/>
				<Stat
					label="EFFECTIVE $/1M"
					value={`${formatUsd(effectiveInput)} / ${formatUsd(effectiveOutput)}`}
					hint="what you charge"
				/>
				<Stat
					label="MARGIN"
					value={margin == null ? "—" : `${margin.toFixed(1)}%`}
					hint={margin == null ? "no provider price" : "over the provider"}
				/>
			</div>

			<DeploymentsSection
				deployments={model.deployments ?? []}
				defaults={
					catalogEntry
						? {
								provider_model: catalogEntry.provider_model,
								api_base: catalogEntry.api_base,
								// A second instance of the same model takes the same
								// inputs as the first; the catalog is the fallback for
								// a model whose first instance predates the field.
								modalities:
									model.deployments?.[0]?.modalities ??
									catalogEntry.modalities,
							}
						: undefined
				}
				onCreate={onCreateDeployment}
				onUpdate={onUpdateDeployment}
				onRemove={onRemoveDeployment}
				isBusy={isDeploymentBusy}
			/>
		</div>
	);
};

export const ModelsPage = () => {
	const {
		models,
		availableModels,
		isLoading,
		isLoadingAvailable,
		upsert,
		isUpserting,
		remove,
		isRemoving,
		createDeployment,
		isCreatingDeployment,
		updateDeployment,
		isUpdatingDeployment,
		removeDeployment,
		isRemovingDeployment,
	} = useServedModelsQuery();

	const [search, setSearch] = useState("");
	const [sheetTarget, setSheetTarget] = useState<ModelSheetTarget | null>(null);
	const [deleting, setDeleting] = useState<ServedModel | null>(null);

	const providerCosts = useMemo(() => {
		const map = new Map<string, AvailableModel>();
		for (const model of availableModels) map.set(model.model_id, model);
		return map;
	}, [availableModels]);

	const suggestions = useMemo(() => {
		const term = search.trim().toLowerCase();
		const served = new Set(models.map((m) => m.model_id));
		return availableModels
			.filter((m) => !served.has(m.model_id))
			.filter((m) => !term || m.model_id.toLowerCase().includes(term))
			.slice(0, 40);
	}, [availableModels, models, search]);

	const handleToggle = async (model: ServedModel, enabled: boolean) => {
		try {
			await upsert({ model_id: model.model_id, enabled });
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to update the model"));
		}
	};

	const handleRemove = async () => {
		if (!deleting) return;
		try {
			await remove(deleting.model_id);
			toast.success(`${deleting.model_id} removed`);
			setDeleting(null);
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to remove the model"));
		}
	};

	const handleCreateDeployment = async (
		model: ServedModel,
		values: DeploymentCreateValues,
	) => {
		try {
			await createDeployment({ modelId: model.model_id, ...values });
			toast.success("Instance added");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to add the instance"));
			throw error;
		}
	};

	const handleUpdateDeployment = async (
		model: ServedModel,
		deploymentId: string,
		values: DeploymentUpdate,
	) => {
		try {
			await updateDeployment({
				modelId: model.model_id,
				deploymentId,
				...values,
			});
			toast.success("Instance updated");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to update the instance"));
			throw error;
		}
	};

	const handleRemoveDeployment = async (
		model: ServedModel,
		deploymentId: string,
	) => {
		try {
			await removeDeployment({ modelId: model.model_id, deploymentId });
			toast.success("Instance removed");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to remove the instance"));
			throw error;
		}
	};

	return (
		<div className="flex flex-col gap-10">
			<SettingsGroup
				title="Your price sheet"
				description="The models your users can call, and what you charge for them. Once a model is listed, your price is yours: a change in the provider's price will not move it."
			>
				{isLoading ? (
					<Skeleton className="h-[120px] w-full rounded-lg" />
				) : models.length === 0 ? (
					<div className="rounded-lg border bg-interactive-secondary px-4 py-6 text-center">
						<p className="font-medium text-foreground text-sm">
							No models yet
						</p>
						<p className="mt-1 text-subtle text-xs">
							Pick a model below to start serving it. Until you list a
							model, every model the gateway offers is priced by the
							provider.
						</p>
					</div>
				) : (
					<div className={SETTINGS_LIST_CLASS}>
						{models.map((model) => (
							<ServedModelCard
								key={model.model_id}
								model={model}
								catalogEntry={providerCosts.get(model.model_id)}
								providerInput={
									providerCosts.get(model.model_id)
										?.provider_input_cost_usd_1m ?? null
								}
								providerOutput={
									providerCosts.get(model.model_id)
										?.provider_output_cost_usd_1m ?? null
								}
								onEdit={() =>
									setSheetTarget({ kind: "edit", model: model })
								}
								onToggle={(enabled) => handleToggle(model, enabled)}
								onRemove={() => setDeleting(model)}
								onCreateDeployment={(values) =>
									handleCreateDeployment(model, values)
								}
								onUpdateDeployment={(deploymentId, values) =>
									handleUpdateDeployment(model, deploymentId, values)
								}
								onRemoveDeployment={(deploymentId) =>
									handleRemoveDeployment(model, deploymentId)
								}
								isDeploymentBusy={
									isCreatingDeployment ||
									isUpdatingDeployment ||
									isRemovingDeployment
								}
							/>
						))}
					</div>
				)}
			</SettingsGroup>

			<SettingsGroup
				title="Add a model"
				description="Every model MeterPal can serve, with the provider's current price. Pick one to set what you charge and connect the provider account behind it -- the provider model, base URL and inputs are filled in from the catalog, so the key is usually all that is left."
			>
				<div className="flex flex-col gap-3">
					<Input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search models, e.g. gpt-4o"
					/>
					{isLoadingAvailable ? (
						<Skeleton className="h-[120px] w-full rounded-lg" />
					) : suggestions.length === 0 ? (
						<p className="px-1 py-2 text-subtle text-xs">
							No more models match that search.
						</p>
					) : (
						<div className={SETTINGS_LIST_CLASS}>
							{suggestions.map((candidate) => (
								<div
									key={candidate.model_id}
									className="flex items-center gap-3 px-4 py-2.5"
								>
									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="truncate font-medium text-foreground text-sm">
											{candidate.display_name || candidate.model_id}
										</span>
										<span className="truncate text-tertiary-foreground text-xs">
											{candidate.model_id}
										</span>
									</div>
									<span className="shrink-0 text-subtle text-xs">
										{formatUsd(candidate.provider_input_cost_usd_1m)} /{" "}
										{formatUsd(candidate.provider_output_cost_usd_1m)}
									</span>
									<Button
										variant="secondary"
										size="sm"
										className="w-20 shrink-0"
										onClick={() =>
											setSheetTarget({
												kind: "create",
												model_id: candidate.model_id,
												display_name: candidate.display_name,
												provider_input:
													candidate.provider_input_cost_usd_1m,
												provider_output:
													candidate.provider_output_cost_usd_1m,
												provider_name: candidate.provider_name,
												provider_model: candidate.provider_model,
												api_base: candidate.api_base,
												modalities: candidate.modalities,
											})
										}
									>
										Add
									</Button>
								</div>
							))}
						</div>
					)}

					<div>
						<Button
							variant="secondary"
							size="sm"
							onClick={() =>
								setSheetTarget({
									kind: "create",
									model_id: "",
									display_name: null,
									provider_input: null,
									provider_output: null,
									provider_name: null,
									provider_model: null,
									api_base: null,
									modalities: null,
								})
							}
						>
							Add a custom model
						</Button>
						<p className="mt-2 text-subtle text-xs leading-4">
							Anything the catalog does not know: a self-hosted endpoint, an
							OpenAI-compatible provider. Use a{" "}
							<code className="font-mono text-foreground text-tiny">
								provider/name
							</code>{" "}
							id.
						</p>
					</div>
				</div>
			</SettingsGroup>

			<ModelSheet
				open={sheetTarget !== null}
				onOpenChange={(open) => {
					if (!open) setSheetTarget(null);
				}}
				target={sheetTarget}
				availableModels={availableModels}
			/>

			<DeleteModelDialog
				model={deleting}
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				onConfirm={handleRemove}
				isDeleting={isRemoving}
			/>
		</div>
	);
};
