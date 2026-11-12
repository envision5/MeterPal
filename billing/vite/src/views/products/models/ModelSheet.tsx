// billing/vite/src/views/products/models/ModelSheet.tsx
//
// The editor for one served model -- the same sheet for adding a model and
// for changing one that is already on the price sheet.
//
// Adding a model used to be a two-step affair: save the row, then come back
// and add the provider account that serves it. That second step is where a
// model actually becomes servable, so the sheet now asks for it up front --
// with the gateway's provider id, the provider's base URL and the model's
// input modalities already filled in from the catalog. From the list, adding
// a model is picking it and pasting a key.
//
// The sheet owns one rule the rest of the app has to respect: a price sheet
// row states a price for both directions or for neither.  Half a price is
// "no opinion" to the runtime -- the provider's price applies and the
// merchant's own markup is ignored -- so the sheet refuses to save one.

import {
	FormLabel,
	Input,
	Sheet,
	SheetContent,
	SheetTitle,
	ShortcutButton,
	Switch,
} from "@autumn/ui";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	SheetFooter,
	SheetHeader,
	SheetSection,
} from "@/components/v2/sheets/SharedSheetComponents";
import {
	type AvailableModel,
	type ServedModel,
	useServedModelsQuery,
} from "@/hooks/queries/useServedModelsQuery";
import { getBackendErr } from "@/utils/genUtils";
import {
	type DeploymentCreateValues,
	buildDeploymentPayload,
	DeploymentForm,
	type DeploymentFormValues,
	DeploymentsList,
	deploymentFormProblem,
	emptyDeploymentForm,
} from "./DeploymentsSection";
import {
	baseInputPrice,
	baseOutputPrice,
	formatUsd,
	marginPct,
	withMarkup,
} from "./modelPricing";

/** What the sheet is editing: a row that exists, or one about to. */
export type ModelSheetTarget =
	| { kind: "edit"; model: ServedModel }
	| {
			kind: "create";
			model_id: string;
			display_name: string | null;
			provider_input: number | null;
			provider_output: number | null;
			/** The catalog's name for the provider, e.g. "302.AI". */
			provider_name: string | null;
			/** What the gateway calls this model, which is not the id the
			 *  merchant picked -- `302ai/claude-fable-5` is served as
			 *  `openai/claude-fable-5`. */
			provider_model: string | null;
			api_base: string | null;
			modalities: string[] | null;
	  };

type Draft = {
	model_id: string;
	display_name: string;
	upstream_model: string;
	enabled: boolean;
	/** Raw text: "" means "not set", which is not the same as "0". */
	input: string;
	output: string;
	/** "plan" leaves the model's own markup unset, so the plan's applies. */
	markup_mode: "plan" | "custom";
	markup: string;
};

const parseNumber = (raw: string): number | null => {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
};

const draftFromTarget = (target: ModelSheetTarget): Draft => {
	if (target.kind === "edit") {
		const model = target.model;
		return {
			model_id: model.model_id,
			display_name: model.display_name ?? "",
			upstream_model: model.upstream_model ?? "",
			enabled: model.enabled,
			input:
				model.input_cost_usd_1m == null
					? ""
					: String(model.input_cost_usd_1m),
			output:
				model.output_cost_usd_1m == null
					? ""
					: String(model.output_cost_usd_1m),
			markup_mode: model.markup_pct == null ? "plan" : "custom",
			markup: model.markup_pct == null ? "" : String(model.markup_pct),
		};
	}

	return {
		model_id: target.model_id,
		display_name: target.display_name ?? "",
		upstream_model: "",
		enabled: true,
		// The provider's price is the starting point, not the answer: the
		// merchant adjusts it here, before the row exists.
		input: target.provider_input == null ? "" : String(target.provider_input),
		output:
			target.provider_output == null ? "" : String(target.provider_output),
		markup_mode: "plan",
		markup: "",
	};
};

/** The instance a new model starts with: the catalog's provider model, base
 *  URL and modalities, and nothing else. The key is the merchant's to type. */
const instanceFromTarget = (
	target: ModelSheetTarget,
): DeploymentFormValues => {
	if (target.kind === "edit") return emptyDeploymentForm();
	return emptyDeploymentForm({
		provider_model: target.provider_model,
		api_base: target.api_base,
		modalities: target.modalities,
	});
};

const ModelSheetForm = ({
	target,
	availableModels,
	onClose,
}: {
	target: ModelSheetTarget;
	/** The catalog, so the sheet can show the provider's price for the model
	 *  being edited -- the baseline the margin is measured against. */
	availableModels: AvailableModel[];
	onClose: () => void;
}) => {
	const {
		models,
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
		fetchPlanMarkup,
	} = useServedModelsQuery();

	const isCreate = target.kind === "create";

	const [draft, setDraft] = useState<Draft>(() => draftFromTarget(target));
	const [instance, setInstance] = useState<DeploymentFormValues>(() =>
		instanceFromTarget(target),
	);

	/**
	 * The row as it stands in the list.
	 *
	 * Read from the query rather than from the sheet's target: an edit saves
	 * and the list refetches, and the instances shown have to be the ones
	 * the server just stored, not the ones the sheet opened with.
	 */
	const saved = useMemo(() => {
		const modelId = target.kind === "edit" ? target.model.model_id : null;
		if (!modelId) return null;
		return models.find((m) => m.model_id === modelId) ?? null;
	}, [models, target]);

	/**
	 * The markup the plan applies to this model on its own.
	 *
	 * Fetched from the server rather than worked out here: a model the
	 * provider feed does not know is charged at no markup, and only the
	 * server knows which case a model is.
	 */
	const [planMarkup, setPlanMarkup] = useState<{
		pct: number;
		source: "model" | "provider" | "default" | "none";
	}>({ pct: 0, source: "none" });

	const modelId = draft.model_id.trim();

	useEffect(() => {
		if (!modelId) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			fetchPlanMarkup(modelId)
				.then((result) => {
					if (cancelled) return;
					setPlanMarkup({
						pct: result.plan_markup_pct,
						source: result.plan_markup_source,
					});
				})
				.catch(() => {
					// The preview falls back to no markup; the save still works.
					if (cancelled) return;
					setPlanMarkup({ pct: 0, source: "none" });
				});
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [modelId, fetchPlanMarkup]);

	const set = <K extends keyof Draft>(field: K, value: Draft[K]) =>
		setDraft((prev) => ({ ...prev, [field]: value }));

	const ownInput = parseNumber(draft.input);
	const ownOutput = parseNumber(draft.output);
	const hasOwnPrice = ownInput != null && ownOutput != null;
	const halfPriced = (ownInput == null) !== (ownOutput == null);

	/**
	 * The provider's price for the model being edited.
	 *
	 * Looked up by the id in the form, not the one the sheet opened with, so
	 * the preview follows the id while it is being typed.
	 */
	const providerPrice = useMemo(() => {
		const entry = availableModels.find((m) => m.model_id === modelId);
		return {
			input: entry?.provider_input_cost_usd_1m ?? null,
			output: entry?.provider_output_cost_usd_1m ?? null,
		};
	}, [availableModels, modelId]);

	/**
	 * The markup that will be charged.
	 *
	 * The merchant's own markup only counts when their row states a price --
	 * a row with no price is "no opinion" to the runtime, and then the
	 * plan's markup applies whatever the merchant put in the box.
	 */
	const chargedMarkup = useMemo(() => {
		if (!hasOwnPrice) return planMarkup.pct;
		if (draft.markup_mode === "plan") return planMarkup.pct;
		return parseNumber(draft.markup) ?? 0;
	}, [hasOwnPrice, draft.markup_mode, draft.markup, planMarkup.pct]);

	const baseInput = baseInputPrice(ownInput, providerPrice.input);
	const baseOutput = baseOutputPrice(ownOutput, providerPrice.output);
	const effectiveInput = withMarkup(baseInput, chargedMarkup);
	const effectiveOutput = withMarkup(baseOutput, chargedMarkup);
	const margin = marginPct(effectiveInput, providerPrice.input);

	const planMarkupLabel =
		planMarkup.source === "none"
			? "your plan has no markup for this model"
			: `your plan's ${planMarkup.source} markup (${planMarkup.pct}%)`;

	/** The model half of the save, shared by both create paths. Returns the
	 *  trimmed id, or null when the form has a problem worth refusing. */
	const saveModel = async (): Promise<string | null> => {
		const trimmedId = draft.model_id.trim();
		if (!trimmedId) {
			toast.error("A model id is required");
			return null;
		}
		if (!trimmedId.includes("/")) {
			toast.error(
				"Use a provider/model id, like openai/gpt-4o-mini or custom/my-model",
			);
			return null;
		}
		if (halfPriced) {
			toast.error(
				"Set both prices, or leave both blank to use the provider's price",
			);
			return null;
		}
		if (ownInput != null && ownInput < 0) {
			toast.error("The input price cannot be negative");
			return null;
		}
		if (ownOutput != null && ownOutput < 0) {
			toast.error("The output price cannot be negative");
			return null;
		}

		const customMarkup =
			draft.markup_mode === "custom" ? parseNumber(draft.markup) : null;
		if (draft.markup_mode === "custom" && customMarkup == null) {
			toast.error("Enter a markup, or use your plan's markup instead");
			return null;
		}
		if (customMarkup != null && customMarkup < 0) {
			toast.error("The markup cannot be negative");
			return null;
		}

		await upsert({
			model_id: trimmedId,
			display_name: draft.display_name.trim() || null,
			upstream_model: draft.upstream_model.trim() || null,
			enabled: draft.enabled,
			input_cost_usd_1m: ownInput,
			output_cost_usd_1m: ownOutput,
			// Null clears the model's own markup, putting the plan's back.
			markup_pct: draft.markup_mode === "plan" ? null : customMarkup,
		});
		return trimmedId;
	};

	const handleSaveChanges = async () => {
		try {
			await saveModel();
			toast.success("Model saved");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to save the model"));
		}
	};

	/**
	 * Add the model, and the provider account that serves it, as one action.
	 *
	 * Two writes, one outcome: if the gateway refuses the instance, the row
	 * is taken back out. Leaving a model on the price sheet that was created
	 * by a failed attempt is worse than leaving nothing -- it looks served,
	 * it is in the allow-list, and it routes to a deployment that does not
	 * exist. `withInstance: false` is the deliberate version of that state,
	 * for a merchant whose gateway already has the model.
	 */
	const handleCreate = async ({ withInstance }: { withInstance: boolean }) => {
		if (withInstance) {
			const problem = deploymentFormProblem(instance, { requireKey: true });
			if (problem) {
				toast.error(problem);
				return;
			}
		}

		let addedId: string | null = null;
		try {
			addedId = await saveModel();
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to add the model"));
			return;
		}
		if (!addedId) return;

		if (!withInstance) {
			toast.success(
				`Added ${addedId}. It has no instance, so nothing routes to it until you add one.`,
			);
			onClose();
			return;
		}

		try {
			await createDeployment({
				modelId: addedId,
				...(buildDeploymentPayload(instance, {
					requireKey: true,
				}) as DeploymentCreateValues),
			});
			toast.success(`Added ${addedId} and its instance.`);
			onClose();
		} catch (error) {
			const reason = getBackendErr(error, "The gateway refused the instance.");
			let rolledBack = true;
			try {
				await remove(addedId);
			} catch {
				rolledBack = false;
			}
			toast.error(
				rolledBack
					? `Nothing was added. ${reason}`
					: `The model was added, but its instance was not: ${reason} Add one from the model's card.`,
			);
		}
	};

	const instanceProblem = isCreate
		? deploymentFormProblem(instance, { requireKey: true })
		: null;
	const isSaving = isUpserting || isCreatingDeployment || isRemoving;

	/**
	 * What a second instance starts from.
	 *
	 * A model's instances all serve the same thing, so the fields a merchant
	 * would otherwise retype are the ones the first instance already has:
	 * the gateway id, the base URL, and the inputs the model takes. The
	 * catalog fills in whatever the first instance predates.
	 */
	const editDefaults = useMemo(() => {
		if (isCreate) return undefined;
		const entry = availableModels.find(
			(m) => m.model_id === target.model.model_id,
		);
		const first = saved?.deployments?.[0];
		if (!entry && !first) return undefined;
		return {
			provider_model: first?.provider_model ?? entry?.provider_model ?? null,
			api_base: first?.api_base ?? entry?.api_base ?? null,
			modalities: first?.modalities ?? entry?.modalities ?? null,
		};
	}, [isCreate, availableModels, saved, target]);

	return (
		<>
			{/* The dialog needs a title of its own for assistive technology;
			 *  the visible heading lives in the sheet header below. */}
			<SheetTitle className="sr-only">
				{isCreate ? "Add model" : "Edit model"}
			</SheetTitle>

			<SheetHeader
				title={isCreate ? "Add model" : "Edit model"}
				description={
					isCreate
						? "Set what you charge, and add the provider account that serves it."
						: "Change what this model costs, how it is served, and where it points."
				}
			/>

			<div className="flex-1 overflow-y-auto">
				<SheetSection title="Model">
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<FormLabel>
								<span className="text-subtle">Display name</span>
							</FormLabel>
							<Input
								value={draft.display_name}
								onChange={(e) => set("display_name", e.target.value)}
								placeholder="GPT-4o mini"
								autoComplete="off"
							/>
							<p className="text-subtle text-xs leading-4">
								What you call this model in the dashboard. Customers still call
								it by its id.
							</p>
						</div>

						<div className="flex flex-col gap-1">
							<FormLabel>
								<span className="text-subtle">Model id</span>
							</FormLabel>
							<Input
								value={draft.model_id}
								onChange={(e) => set("model_id", e.target.value)}
								placeholder="openai/gpt-4o-mini"
								autoComplete="off"
								readOnly={!isCreate}
								className={!isCreate ? "text-subtle" : undefined}
							/>
							<p className="text-subtle text-xs leading-4">
								{isCreate
									? "The id your customers call, and the id the price is filed under. Use provider/model -- custom/ for a model you price yourself."
									: "The id your customers call. It is the key the price is filed under, so it cannot change."}
							</p>
						</div>

						<div className="flex flex-col gap-1">
							<FormLabel>
								<span className="text-subtle">
									Gateway name (optional)
								</span>
							</FormLabel>
							<Input
								value={draft.upstream_model}
								onChange={(e) => set("upstream_model", e.target.value)}
								placeholder={modelId || "deployment name"}
								autoComplete="off"
							/>
							<p className="text-subtle text-xs leading-4">
								The name the gateway calls this model by, when it is not the
								same as the id. Leave blank to use the id.
							</p>
						</div>

						<div className="flex items-center justify-between gap-3">
							<FormLabel>
								<span className="text-subtle">Serve this model</span>
							</FormLabel>
							<Switch
								checked={draft.enabled}
								onCheckedChange={(checked) => set("enabled", checked)}
								aria-label="Serve this model"
							/>
						</div>
						<p className="text-subtle text-xs leading-4">
							Turn it off to keep the model on your sheet but stop serving
							it. An unserved model is not in the allow-list the gateway
							enforces.
						</p>
					</div>
				</SheetSection>

				<SheetSection title="Pricing">
					<div className="flex flex-col gap-3">
						<div className="flex flex-wrap gap-3">
							<div className="flex flex-col gap-1">
								<FormLabel>
									<span className="text-subtle">Input $/1M</span>
								</FormLabel>
								<Input
									className="w-32"
									value={draft.input}
									onChange={(e) => set("input", e.target.value)}
									placeholder="—"
									inputMode="decimal"
									autoComplete="off"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<FormLabel>
									<span className="text-subtle">Output $/1M</span>
								</FormLabel>
								<Input
									className="w-32"
									value={draft.output}
									onChange={(e) => set("output", e.target.value)}
									placeholder="—"
									inputMode="decimal"
									autoComplete="off"
								/>
							</div>
						</div>
						<p className="text-subtle text-xs leading-4">
							Leave both blank to bill the provider's price, or set both to
							charge your own. One without the other is not a price the
							runtime can use.
						</p>
						{halfPriced && (
							<p className="text-destructive text-xs leading-4">
								Set both prices, or leave both blank.
							</p>
						)}

						<div className="flex flex-col gap-1">
							<FormLabel>
								<span className="text-subtle">Markup</span>
							</FormLabel>
							<div className="flex flex-wrap items-center gap-3">
								<div className="flex items-center gap-2">
									<Input
										className="w-28"
										value={
											draft.markup_mode === "plan"
												? String(planMarkup.pct)
												: draft.markup
										}
										onChange={(e) => {
											set("markup_mode", "custom");
											set("markup", e.target.value);
										}}
										placeholder="0"
										inputMode="decimal"
										disabled={draft.markup_mode === "plan"}
										autoComplete="off"
									/>
									<span className="text-subtle text-sm">%</span>
								</div>
								<div className="flex items-center gap-2">
									<Switch
										checked={draft.markup_mode === "plan"}
										onCheckedChange={(checked) =>
											set("markup_mode", checked ? "plan" : "custom")
										}
										aria-label="Use your plan's markup"
									/>
									<span className="text-subtle text-sm">
										Use {planMarkupLabel}
									</span>
								</div>
							</div>
							<p className="text-subtle text-xs leading-4">
								Your own markup overrides the plan's. Switch it off to set
								your own, and on to go back to the plan's.
							</p>
						</div>

						<div className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-3">
							<span className="text-sub text-xs">Effective price</span>
							<div className="flex flex-wrap gap-x-8 gap-y-2">
								<div className="flex flex-col gap-0.5">
									<span className="text-subtle text-xs">Input</span>
									<span className="font-medium text-foreground text-sm">
										{formatUsd(effectiveInput)}
										<span className="text-subtle text-xs"> /1M</span>
									</span>
								</div>
								<div className="flex flex-col gap-0.5">
									<span className="text-subtle text-xs">Output</span>
									<span className="font-medium text-foreground text-sm">
										{formatUsd(effectiveOutput)}
										<span className="text-subtle text-xs"> /1M</span>
									</span>
								</div>
								{margin != null && (
									<div className="flex flex-col gap-0.5">
										<span className="text-subtle text-xs">Margin</span>
										<span className="font-medium text-foreground text-sm">
											{margin.toFixed(1)}%
										</span>
									</div>
								)}
							</div>
							{providerPrice.input != null && (
								<p className="text-subtle text-xs leading-4">
									Provider charges {formatUsd(providerPrice.input)} /{" "}
									{formatUsd(providerPrice.output)} per 1M.
								</p>
							)}
						</div>
					</div>
				</SheetSection>

				{isCreate ? (
					<SheetSection title="Instance" withSeparator={false}>
						<div className="flex flex-col gap-3">
							<p className="text-subtle text-xs leading-4">
								{target.provider_name
									? `One account with ${target.provider_name}. The provider model and base URL are filled in from the catalog -- paste your key and you are serving.`
									: "One provider account and key. Add the base URL of the endpoint you are calling, then paste your key."}
							</p>
							<DeploymentForm
								values={instance}
								setValues={setInstance}
								requireKey={true}
								currentExtraKeys={[]}
								onSubmit={() => undefined}
								isSaving={isSaving}
								hideActions
							/>
							<button
								type="button"
								className="w-fit text-subtle text-xs underline-offset-2 hover:text-foreground hover:underline"
								onClick={() => handleCreate({ withInstance: false })}
							>
								Add the model without an instance
							</button>
						</div>
					</SheetSection>
				) : (
					<SheetSection title="Instances" withSeparator={false}>
						<DeploymentsList
							deployments={saved?.deployments ?? []}
							defaults={editDefaults}
							onCreate={async (values: DeploymentCreateValues) => {
								await createDeployment({
									modelId: target.model.model_id,
									...values,
								});
								toast.success("Instance added");
							}}
							onUpdate={async (deploymentId, values) => {
								await updateDeployment({
									modelId: target.model.model_id,
									deploymentId,
									...values,
								});
								toast.success("Instance saved");
							}}
							onRemove={async (deploymentId) => {
								await removeDeployment({
									modelId: target.model.model_id,
									deploymentId,
								});
								toast.success("Instance removed");
							}}
							isBusy={
								isCreatingDeployment ||
								isUpdatingDeployment ||
								isRemovingDeployment
							}
						/>
					</SheetSection>
				)}
			</div>

			<SheetFooter>
				<ShortcutButton
					variant="secondary"
					singleShortcut="escape"
					onClick={onClose}
				>
					Cancel
				</ShortcutButton>
				{isCreate ? (
					<ShortcutButton
						metaShortcut="enter"
						onClick={() => handleCreate({ withInstance: true })}
						isLoading={isSaving}
						disabled={instanceProblem !== null}
					>
						Add model
					</ShortcutButton>
				) : (
					<ShortcutButton
						metaShortcut="enter"
						onClick={handleSaveChanges}
						isLoading={isUpserting}
					>
						Save changes
					</ShortcutButton>
				)}
			</SheetFooter>
		</>
	);
};

export const ModelSheet = ({
	open,
	onOpenChange,
	target,
	availableModels,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: ModelSheetTarget | null;
	/** The catalog, so the sheet can show the provider's price for the model
	 *  being edited -- the baseline the margin is measured against. */
	availableModels: AvailableModel[];
}) => {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex flex-col overflow-hidden md:max-w-2xl">
				{open && target && (
					<ModelSheetForm
						key={target.kind === "edit" ? target.model.model_id : "create"}
						target={target}
						availableModels={availableModels}
						onClose={() => onOpenChange(false)}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
};
