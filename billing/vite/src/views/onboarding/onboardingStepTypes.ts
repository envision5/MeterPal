// billing/vite/src/views/onboarding/onboardingStepTypes.ts
//
// The shape of one step in a setup wizard.
//
// Both wizards -- the product onboarding and the MeterPal setup -- render
// the same step row, so the row's contract lives here rather than in either
// of them.

export interface OnboardingStepDefinition {
	id: string;
	title: string;
	description: string;
	/** Stands alone on the sidebar card, so it reads as a next action. */
	shortTitle: string;
	waitingFor?: string;
}
