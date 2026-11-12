// billing/vite/src/views/products/models/DeploymentsSection.tsx
//
// The gateway instances behind one served model.
//
// Each instance is one provider account and API key. They all register under
// the same gateway model name, so the gateway load-balances across them --
// that is how a model's traffic spreads past a single account's rate limit.
//
// The form carries the fields every deployment needs up front; the knobs
// most deployments never touch (timeouts, routing precedence, provider
// credential families, input modalities, anything else LiteLLM accepts) live
// behind the Advanced expander and land in the same litellm_params the
// gateway reads.
//
// The first two fields are the ones a merchant should never have to type.
// `provider_model` is the gateway's id for the model, which is a different
// vocabulary from the catalog id they picked (`302ai/claude-fable-5` is
// served as `openai/claude-fable-5`), and `api_base` is a fact about the
// provider. Both arrive as `defaults` from the catalog, so adding a model
// from the list asks for a key and nothing else.

import { Button, Checkbox, FormLabel, Input, Switch } from "@autumn/ui";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	Settings2Icon,
	TrashIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
	DeploymentUpdate,
	ServedModelDeployment,
} from "@/hooks/queries/useServedModelsQuery";

export type DeploymentCreateValues = DeploymentUpdate & { api_key: string };

/** What the catalog knows about a model's instance, so the form can open
 *  filled in. Every field is optional: a custom model has none of them. */
export type DeploymentDefaults = {
	provider_model?: string | null;
	api_base?: string | null;
	modalities?: string[] | null;
};

export interface DeploymentFormValues {
	provider_model: string;
	api_key: string;
	api_base: string;
	rpm: string;
	tpm: string;
	timeout: string;
	max_retries: string;
	weight: string;
	order: string;
	organization: string;
	/** The extra-params textarea. Always blank on open: blank keeps whatever
	 *  is stored, an explicit {} clears it. */
	extra_json: string;
	/** Input modalities beyond text. Null means "no declaration" -- which is
	 *  not the same as text-only, and is the default because a wrong guess
	 *  here silently refuses images the model could have taken. */
	modalities: string[] | null;
}

/** The four modalities the gateway has a flag for. `video` has no gate in
 *  this gateway: it is recorded, not enforced. */
const MODALITY_OPTIONS = [
	{ id: "image", label: "Images" },
	{ id: "audio", label: "Audio" },
	{ id: "pdf", label: "PDFs" },
	{ id: "video", label: "Video" },
] as const;

export const emptyDeploymentForm = (
	defaults?: DeploymentDefaults,
): DeploymentFormValues => ({
	provider_model: defaults?.provider_model ?? "",
	api_key: "",
	api_base: defaults?.api_base ?? "",
	rpm: "",
	tpm: "",
	timeout: "",
	max_retries: "",
	weight: "",
	order: "",
	organization: "",
	extra_json: "",
	modalities: defaults?.modalities ?? null,
});

const toFormValues = (d: ServedModelDeployment): DeploymentFormValues => ({
	provider_model: d.provider_model,
	api_key: "",
	api_base: d.api_base ?? "",
	rpm: d.rpm?.toString() ?? "",
	tpm: d.tpm?.toString() ?? "",
	timeout: d.timeout?.toString() ?? "",
	max_retries: d.max_retries?.toString() ?? "",
	weight: d.weight?.toString() ?? "",
	order: d.order?.toString() ?? "",
	organization: d.organization ?? "",
	extra_json: "",
	modalities: d.modalities ?? null,
});

const parseOptionalNumber = (raw: string): number | null => {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
};

/** The extra-params textarea's three states: blank (keep), valid JSON
 *  (replace), or invalid (block the save). */
type ExtraJsonState =
	| { state: "keep" }
	| { state: "valid"; value: Record<string, unknown> }
	| { state: "invalid"; error: string };

const parseExtraJson = (raw: string): ExtraJsonState => {
	const trimmed = raw.trim();
	if (trimmed === "") return { state: "keep" };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { state: "invalid", error: "Must be a JSON object" };
		}
		return { state: "valid", value: parsed as Record<string, unknown> };
	} catch {
		return { state: "invalid", error: "Invalid JSON" };
	}
};

/**
 * What is missing from an instance before it can be saved, or null.
 *
 * Exported because the create flow submits this form from the sheet's own
 * footer, and two places deciding what "valid" means is how a form ends up
 * with a live button that always fails.
 */
export const deploymentFormProblem = (
	values: DeploymentFormValues,
	{ requireKey }: { requireKey: boolean },
): string | null => {
	const providerModel = values.provider_model.trim();
	if (!providerModel) return "A provider model is required.";
	if (!providerModel.includes("/")) {
		return "Use a provider-prefixed model, like openai/gpt-4o-mini.";
	}
	if (requireKey && !values.api_key.trim()) {
		return "An API key is required.";
	}
	if (parseExtraJson(values.extra_json).state === "invalid") {
		return "The extra params are not valid JSON.";
	}
	return null;
};

/** The request body for an instance, from the form's strings. */
export const buildDeploymentPayload = (
	values: DeploymentFormValues,
	{ requireKey }: { requireKey: boolean },
): DeploymentCreateValues | DeploymentUpdate => {
	const extraState = parseExtraJson(values.extra_json);
	return {
		provider_model: values.provider_model.trim(),
		api_base: values.api_base.trim() || null,
		rpm: parseOptionalNumber(values.rpm),
		tpm: parseOptionalNumber(values.tpm),
		timeout: parseOptionalNumber(values.timeout),
		max_retries: parseOptionalNumber(values.max_retries),
		weight: parseOptionalNumber(values.weight),
		order: parseOptionalNumber(values.order),
		organization: values.organization.trim() || null,
		modalities: values.modalities,
		...(extraState.state === "valid" ? { extra_params: extraState.value } : {}),
		...(requireKey ? { api_key: values.api_key.trim() } : {}),
	};
};

/** Shared by "add instance" and "edit instance": the fields one deployment
 *  carries. In edit mode the key starts empty -- leaving it that way keeps
 *  the stored key. */
export const DeploymentForm = ({
	values,
	setValues,
	requireKey,
	currentExtraKeys,
	onSubmit,
	onCancel,
	isSaving,
	hideActions,
}: {
	values: DeploymentFormValues;
	setValues: (values: DeploymentFormValues) => void;
	/** Adding: a key must be typed. Editing: empty keeps the stored key. */
	requireKey: boolean;
	/** Key names already stored for this instance, shown so an edit knows
	 *  what "leave blank" is keeping. */
	currentExtraKeys: string[];
	onSubmit: (values: DeploymentCreateValues | DeploymentUpdate) => void;
	/** Absent when the form is the whole of a create flow: there is nothing
	 *  to go back to but the sheet. */
	onCancel?: () => void;
	isSaving: boolean;
	/** The create flow submits from the sheet footer, so the form's own
	 *  buttons would be a second, differently-guarded way to save. */
	hideActions?: boolean;
}) => {
	const [showKey, setShowKey] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);

	const set = (field: keyof DeploymentFormValues) => (value: string) =>
		setValues({ ...values, [field]: value });

	const extraState = useMemo(
		() => parseExtraJson(values.extra_json),
		[values.extra_json],
	);

	const canSave = deploymentFormProblem(values, { requireKey }) === null;

	const buildPayload = (): DeploymentCreateValues | DeploymentUpdate =>
		buildDeploymentPayload(values, { requireKey });


	const advancedHasValue =
		currentExtraKeys.length > 0 || values.modalities != null;

	const toggleModality = (id: string, checked: boolean) => {
		const current = values.modalities ?? [];
		const next = checked
			? [...current, id]
			: current.filter((modality) => modality !== id);
		setValues({ ...values, modalities: next });
	};

	return (
		<div className="flex flex-col gap-3 rounded-lg border bg-background px-3 py-3">
			{/* Two rows rather than one wrapping row: the four fields together
			 *  are wider than the sheet, and letting them wrap puts TPM alone
			 *  on its own line on some widths and not others. */}
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1">
					<FormLabel>
						<span className="text-subtle">Provider model</span>
					</FormLabel>
					<Input
						className="w-64"
						value={values.provider_model}
						onChange={(e) => set("provider_model")(e.target.value)}
						placeholder="openai/gpt-4o-mini"
						autoComplete="off"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<FormLabel>
						<span className="text-subtle">API base</span>
					</FormLabel>
					<Input
						className="w-64"
						value={values.api_base}
						onChange={(e) => set("api_base")(e.target.value)}
						placeholder="https://api.example.com/v1"
						autoComplete="off"
					/>
				</div>
			</div>
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1">
					<FormLabel>
						<span className="text-subtle">RPM</span>
					</FormLabel>
					<Input
						className="w-28"
						value={values.rpm}
						onChange={(e) => set("rpm")(e.target.value)}
						placeholder="—"
						inputMode="numeric"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<FormLabel>
						<span className="text-subtle">TPM</span>
					</FormLabel>
					<Input
						className="w-28"
						value={values.tpm}
						onChange={(e) => set("tpm")(e.target.value)}
						placeholder="—"
						inputMode="numeric"
					/>
				</div>
			</div>

			<p className="text-subtle text-xs leading-4">
				<strong className="font-medium text-tertiary-foreground">RPM</strong>{" "}
				and <strong className="font-medium text-tertiary-foreground">TPM</strong>{" "}
				are ceilings this gateway enforces before it calls the provider:
				requests per minute and tokens per minute for this one account. Set
				them just under the limit your provider gives you, and the gateway
				sends traffic to another instance when this one is at its ceiling
				instead of letting the provider reject the call. Leave both blank for
				no ceiling. The API base is the root URL, not the endpoint — the
				gateway appends <code className="font-mono">/chat/completions</code>{" "}
				itself.
			</p>

			<div className="flex flex-col gap-1">
				<FormLabel>
					<span className="text-subtle">
						API key{!requireKey && " (leave blank to keep the current key)"}
					</span>
				</FormLabel>
				<div className="flex gap-2">
					<Input
						className="w-72"
						value={values.api_key}
						onChange={(e) => set("api_key")(e.target.value)}
						placeholder="sk-..."
						type={showKey ? "text" : "password"}
						autoComplete="off"
					/>
					<Button
						variant="secondary"
						onClick={() => setShowKey((v) => !v)}
						type="button"
					>
						{showKey ? "Hide" : "Show"}
					</Button>
				</div>
				<p className="text-subtle text-xs leading-4">
					Stored encrypted and passed to the gateway. MeterPal never shows it
					again -- only its last four characters.
				</p>
			</div>

			<div>
				<button
					type="button"
					className="flex w-fit items-center gap-1.5 text-subtle text-xs hover:text-foreground"
					onClick={() => setAdvancedOpen((v) => !v)}
				>
					{advancedOpen ? (
						<ChevronDownIcon className="size-3.5" />
					) : (
						<ChevronRightIcon className="size-3.5" />
					)}
					<Settings2Icon className="size-3.5" />
					Advanced settings
					{advancedHasValue && (
						<span className="rounded-full bg-interactive px-1.5 py-0.5 font-medium text-foreground text-tiny-id">
							{currentExtraKeys.length + (values.modalities != null ? 1 : 0)}
						</span>
					)}
				</button>

				{advancedOpen && (
					<div className="mt-3 flex flex-col gap-3 rounded-lg border px-3 py-3">
						<div className="flex flex-col gap-2 rounded-lg border bg-interactive-secondary px-3 py-2.5">
							<div className="flex items-center justify-between gap-3">
								<div className="flex flex-col gap-0.5">
									<span className="font-medium text-foreground text-xs">
										Multimodal
									</span>
									<span className="text-subtle text-xs leading-4">
										{values.modalities == null
											? "Off — the gateway accepts whatever this provider does. Turn it on to declare the inputs this model takes."
											: "On — the gateway accepts text plus whatever is checked below, and refuses the rest."}
									</span>
								</div>
								<Switch
									checked={values.modalities != null}
									onCheckedChange={(checked) =>
										setValues({
											...values,
											// Turning it on starts from text-only
											// rather than guessing: a guess that is
											// wrong in the generous direction sends
											// images to a model that cannot read them.
											modalities: checked ? [] : null,
										})
									}
									aria-label="Declare input modalities"
								/>
							</div>
							{values.modalities != null && (
								<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
									{MODALITY_OPTIONS.map((option) => (
										<label
											key={option.id}
											className="flex cursor-pointer items-center gap-1.5 text-foreground text-xs"
										>
											<Checkbox
												checked={values.modalities?.includes(option.id)}
												onCheckedChange={(checked) =>
													toggleModality(option.id, checked === true)
												}
												aria-label={option.label}
											/>
											{option.label}
										</label>
									))}
									{values.modalities.length === 0 && (
										<span className="text-subtle text-xs">Text only</span>
									)}
								</div>
							)}
						</div>

						<p className="text-subtle text-xs leading-4">
							Passed to the gateway with the call. Everything here is
							optional -- the fields cover LiteLLM's timeout and routing
							precedence; the JSON accepts anything else it supports
							(provider credentials, tags, ...), except params MeterPal
							manages elsewhere.
						</p>
						<div className="flex flex-wrap items-end gap-3">
							<div className="flex flex-col gap-1">
								<FormLabel>
									<span className="text-subtle">Timeout (s)</span>
								</FormLabel>
								<Input
									className="w-24"
									value={values.timeout}
									onChange={(e) => set("timeout")(e.target.value)}
									placeholder="—"
									inputMode="decimal"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<FormLabel>
									<span className="text-subtle">Max retries</span>
								</FormLabel>
								<Input
									className="w-24"
									value={values.max_retries}
									onChange={(e) => set("max_retries")(e.target.value)}
									placeholder="—"
									inputMode="numeric"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<FormLabel>
									<span className="text-subtle">Weight</span>
								</FormLabel>
								<Input
									className="w-24"
									value={values.weight}
									onChange={(e) => set("weight")(e.target.value)}
									placeholder="—"
									inputMode="numeric"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<FormLabel>
									<span className="text-subtle">Order</span>
								</FormLabel>
								<Input
									className="w-24"
									value={values.order}
									onChange={(e) => set("order")(e.target.value)}
									placeholder="—"
									inputMode="numeric"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<FormLabel>
									<span className="text-subtle">Organization</span>
								</FormLabel>
								<Input
									className="w-44"
									value={values.organization}
									onChange={(e) => set("organization")(e.target.value)}
									placeholder="OpenAI org id"
									autoComplete="off"
								/>
							</div>
						</div>
						<div className="flex flex-col gap-1">
							<FormLabel>
								<span className="text-subtle">
									Extra LiteLLM params (JSON)
									{!requireKey &&
										currentExtraKeys.length > 0 &&
										` -- currently: ${currentExtraKeys.join(", ")} (leave blank to keep)`}
								</span>
							</FormLabel>
							<textarea
								className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs text-foreground placeholder:text-placeholder-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								value={values.extra_json}
								onChange={(e) => set("extra_json")(e.target.value)}
								placeholder={
									requireKey
										? '{"api_version": "2024-02-01", "vertex_project": "my-project", ...}'
										: "Leave blank to keep the stored params; enter {} to clear them"
								}
								autoComplete="off"
								spellCheck={false}
							/>
							{extraState.state === "invalid" && (
								<p className="text-destructive text-xs">{extraState.error}</p>
							)}
							<p className="text-subtle text-xs leading-4">
								Stored encrypted with the key. Pricing and budgets are
								deliberately not accepted here -- the price sheet owns what
								a call costs.
							</p>
						</div>
					</div>
				)}
			</div>

			{!hideActions && (
				<div className="flex gap-2">
					<Button
						size="sm"
						onClick={() => onSubmit(buildPayload())}
						isLoading={isSaving}
						disabled={!canSave}
					>
						Save instance
					</Button>
					{onCancel && (
						<Button
							size="sm"
							variant="secondary"
							onClick={onCancel}
							type="button"
						>
							Cancel
						</Button>
					)}
				</div>
			)}
		</div>
	);
};

/** The one-line summary under an instance: provider model, masked key, and
 *  whichever advanced knobs are set. */
const instanceSummary = (d: ServedModelDeployment): string[] => {
	const parts: string[] = [`key ••••${d.api_key_hint}`];
	if (d.api_base) parts.push(d.api_base);
	if (d.rpm != null) parts.push(`${d.rpm} rpm`);
	if (d.tpm != null) parts.push(`${d.tpm} tpm`);
	if (d.timeout != null) parts.push(`${d.timeout}s timeout`);
	if (d.max_retries != null) parts.push(`${d.max_retries} retries`);
	if (d.weight != null) parts.push(`weight ${d.weight}`);
	if (d.order != null) parts.push(`order ${d.order}`);
	if (d.organization) parts.push(`org ${d.organization}`);
	if (d.modalities != null) {
		parts.push(d.modalities.length === 0 ? "text only" : d.modalities.join(" + "));
	}
	if (d.extra_params_keys.length > 0) {
		parts.push(`+${d.extra_params_keys.length} advanced`);
	}
	return parts;
};

/**
 * The instances behind a model, without a collapse around them.
 *
 * The card on the page wraps this in a disclosure; the editor sheet shows it
 * open.  Either way it is the same list and the same form.
 */
export const DeploymentsList = ({
	deployments,
	defaults,
	onCreate,
	onUpdate,
	onRemove,
	isBusy,
}: {
	deployments: ServedModelDeployment[];
	/** What a new instance starts from -- the catalog's provider model, base
	 *  URL and modalities. Absent for a model the catalog does not know. */
	defaults?: DeploymentDefaults;
	onCreate: (values: DeploymentCreateValues) => Promise<void>;
	onUpdate: (
		deploymentId: string,
		values: DeploymentUpdate,
	) => Promise<void>;
	onRemove: (deploymentId: string) => Promise<void>;
	isBusy: boolean;
}) => {
	const [adding, setAdding] = useState(false);
	const [addValues, setAddValues] = useState<DeploymentFormValues>(() =>
		emptyDeploymentForm(defaults),
	);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValues, setEditValues] = useState<DeploymentFormValues>(() =>
		emptyDeploymentForm(),
	);
	const [removingId, setRemovingId] = useState<string | null>(null);

	const handleCreate = async (values: DeploymentCreateValues) => {
		try {
			await onCreate(values);
			setAddValues(emptyDeploymentForm(defaults));
			setAdding(false);
		} catch {
			// The caller toasted the failure; keep the form and its values up.
		}
	};

	const handleUpdate = async (
		deploymentId: string,
		values: DeploymentUpdate,
	) => {
		try {
			await onUpdate(deploymentId, values);
			setEditingId(null);
		} catch {
			// The caller toasted the failure.
		}
	};

	const handleRemove = async (deploymentId: string) => {
		setRemovingId(deploymentId);
		try {
			await onRemove(deploymentId);
		} catch {
			// The caller toasted the failure.
		} finally {
			setRemovingId(null);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="text-subtle text-xs leading-4">
				Each instance is one provider account and key. The gateway
				load-balances across them, so more instances spread the model's
				traffic past one account's rate limit.
			</p>

			{deployments.map((deployment) =>
				editingId === deployment.id ? (
					<DeploymentForm
						key={deployment.id}
						values={editValues}
						setValues={setEditValues}
						requireKey={false}
						currentExtraKeys={deployment.extra_params_keys}
						onSubmit={(values) => handleUpdate(deployment.id, values)}
						onCancel={() => setEditingId(null)}
						isSaving={isBusy}
					/>
				) : (
					<div
						key={deployment.id}
						className="flex flex-wrap items-center gap-3 rounded-lg border bg-background px-3 py-2"
					>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="truncate font-medium text-foreground text-sm">
								{deployment.provider_model}
							</span>
							<span className="truncate text-tertiary-foreground text-xs">
								{instanceSummary(deployment).map((part, i) => (
									<span key={part} className="ml-1.5 first:ml-0">
										{i > 0 && <span className="mr-1.5">·</span>}
										{part}
									</span>
								))}
							</span>
						</div>
						<Button
							variant="secondary"
							size="sm"
							className="shrink-0"
							onClick={() => {
								setEditingId(deployment.id);
								setEditValues(toFormValues(deployment));
							}}
						>
							Edit
						</Button>
						<Button
							variant="muted"
							size="sm"
							className="shrink-0"
							isLoading={removingId === deployment.id}
							onClick={() => handleRemove(deployment.id)}
							aria-label="Remove instance"
						>
							<TrashIcon className="size-3.5" />
						</Button>
					</div>
				),
			)}

			{adding ? (
				<DeploymentForm
					values={addValues}
					setValues={setAddValues}
					requireKey={true}
					currentExtraKeys={[]}
					onSubmit={(values) => handleCreate(values as DeploymentCreateValues)}
					onCancel={() => {
						setAddValues(emptyDeploymentForm(defaults));
						setAdding(false);
					}}
					isSaving={isBusy}
				/>
			) : (
				<Button
					variant="secondary"
					size="sm"
					className="w-fit"
					onClick={() => {
						setAddValues(emptyDeploymentForm(defaults));
						setAdding(true);
					}}
				>
					Add instance
				</Button>
			)}
		</div>
	);
};

export const DeploymentsSection = ({
	deployments,
	defaults,
	onCreate,
	onUpdate,
	onRemove,
	isBusy,
}: {
	deployments: ServedModelDeployment[];
	defaults?: DeploymentDefaults;
	onCreate: (values: DeploymentCreateValues) => Promise<void>;
	onUpdate: (
		deploymentId: string,
		values: DeploymentUpdate,
	) => Promise<void>;
	onRemove: (deploymentId: string) => Promise<void>;
	isBusy: boolean;
}) => {
	const [open, setOpen] = useState(false);

	return (
		<div className="flex flex-col gap-2 border-t pt-3">
			<button
				type="button"
				className="flex w-fit items-center gap-1.5 text-subtle text-xs hover:text-foreground"
				onClick={() => setOpen((v) => !v)}
			>
				{open ? (
					<ChevronDownIcon className="size-3.5" />
				) : (
					<ChevronRightIcon className="size-3.5" />
				)}
				Instances
				<span className="rounded-full bg-interactive px-1.5 py-0.5 font-medium text-foreground text-tiny-id">
					{deployments.length}
				</span>
			</button>

			{open && (
				<DeploymentsList
					deployments={deployments}
					defaults={defaults}
					onCreate={onCreate}
					onUpdate={onUpdate}
					onRemove={onRemove}
					isBusy={isBusy}
				/>
			)}
		</div>
	);
};
