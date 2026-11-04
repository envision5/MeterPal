// billing/vite/src/views/setup/SetupView.tsx
//
// The MeterPal setup wizard.
//
// Five steps, and each one ends in a state the merchant can SEE: PayPal
// connected, a plan that can be billed, a price sheet, an install command,
// and a real metered call.  Nothing here is a checklist the wizard keeps
// for itself -- every "done" is read back from the product.

import { PageContainer, PageHeader, Skeleton } from "@autumn/ui";
import { RocketIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useOrgPaypalQuery } from "@/hooks/queries/useOrgPaypalQuery";
import { ConfigurePayPal } from "@/views/developer/configure-paypal/ConfigurePayPal";
import { OnboardingStep } from "@/views/onboarding/OnboardingStep";
import { useSetupState, type SmokeTestResult } from "./hooks/useSetupState";
import { InstallStep } from "./panels/InstallStep";
import { ModelsStep } from "./panels/ModelsStep";
import { PlanStep } from "./panels/PlanStep";
import { SmokeTestStep } from "./panels/SmokeTestStep";
import { SETUP_STEPS, type SetupStepId } from "./setupSteps";

export const SetupView = () => {
	const {
		state,
		isLoading,
		refetch,
		createPaypalPlan,
		isCreatingPlan,
		runSmokeTest,
		isRunningSmokeTest,
	} = useSetupState();

	// The PayPal connection is made inside the shared PayPal panel, so the
	// wizard watches that query rather than owning the form itself.
	const { paypalConfig } = useOrgPaypalQuery();

	const [expanded, setExpanded] = useState<SetupStepId | null>("paypal");
	const [smokeResult, setSmokeResult] = useState<SmokeTestResult | null>(null);

	useEffect(() => {
		// The PayPal panel just connected or disconnected: the setup state
		// reads the same org row, so it has to be refreshed.
		if (paypalConfig) refetch();
	}, [paypalConfig, refetch]);

	const steps = SETUP_STEPS;

	const completed: Record<SetupStepId, boolean> = {
		paypal: state?.paypal.connected ?? false,
		plan: (state?.plans ?? []).some(
			(plan) => plan.amount_usd != null && plan.paypal_plan_id != null,
		),
		models: (state?.models ?? []).some((model) => model.enabled),
		// The SDK lives in the merchant's app, so the dashboard cannot see it.
		// The install step is complete when the test call in the next step
		// works, which is the only honest check.
		install: (state?.smoke_test != null) ?? false,
		smoke: state?.smoke_test != null,
	};

	const handleSmokeTest = async () => {
		const result = await runSmokeTest();
		setSmokeResult(result);
	};

	if (isLoading) {
		return (
			<PageContainer>
				<Skeleton className="h-[400px] w-full rounded-lg" />
			</PageContainer>
		);
	}

	return (
		<PageContainer>
			<PageHeader
				icon={<RocketIcon size={16} weight="fill" className="text-subtle" />}
				title="Set up MeterPal"
			/>
			<p className="mb-6 px-2 text-subtle text-xs">
				Five steps from an empty account to a metered, billed AI call.
				Every step shows you that it worked.
			</p>

			<div className="flex flex-col divide-y rounded-lg border border-border/50">
				{steps.map((step, index) => {
					const id = step.id as SetupStepId;
					const isExpanded = expanded === id;

					return (
						<OnboardingStep
							key={id}
							step={step}
							index={index}
							isComplete={completed[id]}
							isExpanded={isExpanded}
							onToggle={() => setExpanded(isExpanded ? null : id)}
							wide
							action={
								id === "paypal" ? (
									<ConfigurePayPal />
								) : id === "plan" ? (
									<PlanStep
										plans={state?.plans ?? []}
										onCreatePaypalPlan={createPaypalPlan}
										isCreating={isCreatingPlan}
									/>
								) : id === "models" ? (
									<ModelsStep models={state?.models ?? []} />
								) : id === "install" ? (
									<InstallStep apiUrl={state?.install.api_url ?? ""} />
								) : (
									<SmokeTestStep
										models={state?.models ?? []}
										result={smokeResult}
										lastRun={state?.smoke_test ?? null}
										onRun={handleSmokeTest}
										isRunning={isRunningSmokeTest}
									/>
								)
							}
						/>
					);
				})}
			</div>
		</PageContainer>
	);
};

export default SetupView;
