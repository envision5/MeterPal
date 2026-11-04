// billing/vite/src/views/products/models/ModelsPage.tsx
//
// The merchant's price sheet: which models they serve, and what they charge.
//
// The prices shown here are the MERCHANT's prices.  They become the runtime
// authority the moment they are saved: a change in the provider's price
// cannot move them afterwards.

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
import { type DeploymentCreateValues, DeploymentsSection } from "./DeploymentsSection";

/** What one megabyte of tokens costs, for a quick sanity read. */
const formatCost = (value: number | null | undefined) => {
	if (value == null) return "—";
	return `$${value.toFixed(value < 1 ? 4 : 2)}`;
};

const ServedModelRow = ({
	model,
	providerInput,
	providerOutput,
	onChange,
	onRemove,
	isSaving,
	onCreateDeployment,
	onUpdateDeployment,
	onRemoveDeployment,
	isDeploymentBusy,
}: {
	model: ServedModel;
	providerInput: number | null;
	providerOutput: number | null;
	onChange: (update: Partial<ServedModel>) => void;
	onRemove: () => void;
	isSaving: boolean;
	onCreateDeployment: (values: DeploymentCreateValues) => Promise<void>;
	onUpdateDeployment: (
		deploymentId: string,
		values: DeploymentUpdate,
	) => Promise<void>;
	onRemoveDeployment: (deploymentId: string) => Promise<void>;
	isDeploymentBusy: boolean;
}) => {
	const [input, setInput] = useState(
		model.input_cost_usd_1m?.toString() ?? "",
	);
	const [output, setOutput] = useState(
		model.output_cost_usd_1m?.toString() ?? "",
	);
	const [markup, setMarkup] = useState(model.markup_pct?.toString() ?? "");

	const commit = (field: "input" | "output" | "markup") => {
		const raw = field === "input" ? input : field === "output" ? output : markup;
		const parsed = raw.trim() === "" ? null : Number(raw);
		if (parsed != null && Number.isNaN(parsed)) return;

		if (field === "input") {
			onChange({ input_cost_usd_1m: parsed });
		} else if (field === "output") {
			onChange({ output_cost_usd_1m: parsed });
		} else {
			onChange({ markup_pct: parsed });
		}
	};

	// The effective price: the merchant's price plus their markup.
	const markupPct = markup.trim() === "" ? 0 : Number(markup);
	const effectiveInput =
		model.input_cost_usd_1m == null
			? null
			: model.input_cost_usd_1m * (1 + (Number.isNaN(markupPct) ? 0 : markupPct) / 100);
	const margin =
		providerInput && effectiveInput
			? ((effectiveInput - providerInput) / effectiveInput) * 100
			: null;

	return (
		<div className="flex flex-col gap-3 px-4 py-3.5">
			<div className="flex items-center gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate font-medium text-foreground text-sm">
						{model.display_name || model.model_id}
					</span>
					<span className="truncate text-tertiary-foreground text-xs">
						{model.model_id}
						{providerInput != null && (
							<span className="ml-2 text-subtle">
								provider {formatCost(providerInput)} / {formatCost(providerOutput)}
							</span>
						)}
					</span>
				</div>
				<div className="flex w-16 shrink-0 items-center justify-end">
					<span className="font-medium text-subtle text-xs">
						{model.enabled ? "Served" : "Off"}
					</span>
					<Switch
						checked={model.enabled}
						onCheckedChange={(checked) => onChange({ enabled: checked })}
						aria-label={`Serve ${model.model_id}`}
					/>
				</div>
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

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1">
					<span className="text-subtle text-tiny">Input $/1M</span>
					<Input
						className="w-28"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onBlur={() => commit("input")}
						placeholder="0.00"
						inputMode="decimal"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-subtle text-tiny">Output $/1M</span>
					<Input
						className="w-28"
						value={output}
						onChange={(e) => setOutput(e.target.value)}
						onBlur={() => commit("output")}
						placeholder="0.00"
						inputMode="decimal"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-subtle text-tiny">Markup %</span>
					<Input
						className="w-24"
						value={markup}
						onChange={(e) => setMarkup(e.target.value)}
						onBlur={() => commit("markup")}
						placeholder="plan"
						inputMode="decimal"
					/>
				</div>
				<div className="flex flex-col gap-1 pb-1">
					<span className="text-subtle text-tiny">Effective input</span>
					<span className="font-medium text-foreground text-sm">
						{formatCost(effectiveInput)}
						{margin != null && (
							<span className="ml-1.5 text-subtle text-tiny">
								{margin.toFixed(0)}% margin
							</span>
						)}
					</span>
				</div>
				{isSaving && <span className="pb-1.5 text-subtle text-tiny">Saving…</span>}
			</div>

			<DeploymentsSection
				deployments={model.deployments ?? []}
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
		createDeployment,
		isCreatingDeployment,
		updateDeployment,
		isUpdatingDeployment,
		removeDeployment,
		isRemovingDeployment,
	} = useServedModelsQuery();

	const [search, setSearch] = useState("");
	const [adding, setAdding] = useState<string | null>(null);

	// The custom-model form: any "<provider>/<name>" the catalog does not
	// know -- a self-hosted endpoint, an OpenAI-compatible provider.
	const [customOpen, setCustomOpen] = useState(false);
	const [customModelId, setCustomModelId] = useState("");
	const [customDisplayName, setCustomDisplayName] = useState("");
	const [customInput, setCustomInput] = useState("");
	const [customOutput, setCustomOutput] = useState("");
	const isCustomModelIdValid = /.+\/.+/.test(customModelId.trim());

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

	const handleChange = async (
		model: ServedModel,
		update: Partial<ServedModel>,
	) => {
		try {
			await upsert({ model_id: model.model_id, ...update });
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to update the model"));
		}
	};

	const handleAdd = async (candidate: AvailableModel) => {
		setAdding(candidate.model_id);
		try {
			await upsert({
				model_id: candidate.model_id,
				display_name: candidate.display_name,
				enabled: true,
				input_cost_usd_1m: candidate.provider_input_cost_usd_1m,
				output_cost_usd_1m: candidate.provider_output_cost_usd_1m,
			});
			toast.success(`${candidate.model_id} added`);
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to add the model"));
		} finally {
			setAdding(null);
		}
	};

	const handleRemove = async (model: ServedModel) => {
		try {
			await remove(model.model_id);
			toast.success(`${model.model_id} removed`);
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

	const handleRemoveDeployment = async (model: ServedModel, deploymentId: string) => {
		try {
			await removeDeployment({ modelId: model.model_id, deploymentId });
			toast.success("Instance removed");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to remove the instance"));
			throw error;
		}
	};

	const handleAddCustomModel = async () => {
		try {
			await upsert({
				model_id: customModelId.trim(),
				display_name: customDisplayName.trim() || null,
				enabled: true,
				input_cost_usd_1m:
					customInput.trim() === "" ? null : Number(customInput),
				output_cost_usd_1m:
					customOutput.trim() === "" ? null : Number(customOutput),
			});
			toast.success(`${customModelId.trim()} added`);
			setCustomOpen(false);
			setCustomModelId("");
			setCustomDisplayName("");
			setCustomInput("");
			setCustomOutput("");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to add the model"));
		}
	};

	return (
		<div className="flex flex-col gap-10">
			<SettingsGroup
				title="Served models"
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
							<ServedModelRow
								key={model.model_id}
								model={model}
								providerInput={
									providerCosts.get(model.model_id)
										?.provider_input_cost_usd_1m ?? null
								}
								providerOutput={
									providerCosts.get(model.model_id)
										?.provider_output_cost_usd_1m ?? null
								}
								onChange={(update) => handleChange(model, update)}
								onRemove={() => handleRemove(model)}
								isSaving={isUpserting}
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
				description="Every model MeterPal can serve, with the provider's current price. Adding one copies that price as your starting point."
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
										{formatCost(candidate.provider_input_cost_usd_1m)} /{" "}
										{formatCost(candidate.provider_output_cost_usd_1m)}
									</span>
									<Button
										variant="secondary"
										size="sm"
										className="w-20 shrink-0"
										isLoading={adding === candidate.model_id}
										onClick={() => handleAdd(candidate)}
									>
										Add
									</Button>
								</div>
								))}
							</div>
						)}

						{customOpen ? (
							<div className="flex flex-col gap-3 rounded-lg border bg-background px-3 py-3">
								<div className="flex flex-wrap items-end gap-3">
									<div className="flex flex-col gap-1">
										<span className="text-subtle text-tiny">Model id</span>
										<Input
											className="w-56"
											value={customModelId}
											onChange={(e) => setCustomModelId(e.target.value)}
											placeholder="custom/my-model"
											autoComplete="off"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<span className="text-subtle text-tiny">Display name</span>
										<Input
											className="w-44"
											value={customDisplayName}
											onChange={(e) => setCustomDisplayName(e.target.value)}
											placeholder="Optional"
											autoComplete="off"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<span className="text-subtle text-tiny">Input $/1M</span>
										<Input
											className="w-28"
											value={customInput}
											onChange={(e) => setCustomInput(e.target.value)}
											placeholder="0.00"
											inputMode="decimal"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<span className="text-subtle text-tiny">Output $/1M</span>
										<Input
											className="w-28"
											value={customOutput}
											onChange={(e) => setCustomOutput(e.target.value)}
											placeholder="0.00"
											inputMode="decimal"
										/>
									</div>
								</div>
								<p className="text-subtle text-xs leading-4">
									Anything the catalog does not know: a self-hosted endpoint,
									an OpenAI-compatible provider. Use a{" "}
									<code className="font-mono text-foreground text-tiny">
										provider/name
									</code>{" "}
									id, then add instances for it on the model above.
								</p>
								<div className="flex gap-2">
									<Button
										size="sm"
										onClick={handleAddCustomModel}
										isLoading={isUpserting}
										disabled={!isCustomModelIdValid}
									>
										Add model
									</Button>
									<Button
										size="sm"
										variant="secondary"
										type="button"
										onClick={() => setCustomOpen(false)}
									>
										Cancel
									</Button>
								</div>
							</div>
						) : (
							<div>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => setCustomOpen(true)}
								>
									Add a custom model
								</Button>
							</div>
						)}
					</div>
				</SettingsGroup>
			</div>
		);
	};
