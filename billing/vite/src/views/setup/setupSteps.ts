// billing/vite/src/views/setup/setupSteps.ts
//
// The MeterPal setup wizard's steps.
//
// Each step ends in a verifiable state: the merchant can see that it worked
// before moving on, and nothing here asks for anything the product cannot
// then do for them.

import type { OnboardingStepDefinition } from "@/views/onboarding/onboardingStepTypes";

export type SetupStepId =
	| "paypal"
	| "plan"
	| "models"
	| "install"
	| "smoke";

export const SETUP_STEPS: OnboardingStepDefinition[] = [
	{
		id: "paypal",
		title: "Connect PayPal",
		shortTitle: "Connect PayPal",
		description:
			"PayPal collects the money. Connect the account that should receive it, so your users pay you and not the platform.",
		waitingFor: "Waiting for PayPal",
	},
	{
		id: "plan",
		title: "Create a plan",
		shortTitle: "Create a plan",
		description:
			"What your users buy: the plan, what it costs, and how much AI usage it includes. MeterPal creates the PayPal plan that bills it.",
		waitingFor: "Waiting for a plan",
	},
	{
		id: "models",
		title: "Choose models and prices",
		shortTitle: "Choose your models",
		description:
			"Which models you serve and what you charge for them. Your price is yours: a change in the provider's price will not move it.",
		waitingFor: "Waiting for a model",
	},
	{
		id: "install",
		title: "Install the SDK",
		shortTitle: "Install the SDK",
		description:
			"One import in your server. Every call your app makes is metered and billed to the end user automatically.",
		waitingFor: "Waiting for an install",
	},
	{
		id: "smoke",
		title: "Send a metered test call",
		shortTitle: "Send a test call",
		description:
			"A real call, metered and billed. You see exactly what it costs before you write a line of application code.",
		waitingFor: "Waiting for a test call",
	},
];
