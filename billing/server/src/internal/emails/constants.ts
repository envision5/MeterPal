// RESEND_FROM overrides the whole from-address — needed on Resend's free
// tier, where an unverified domain may only send from onboarding@resend.dev.
export const FROM_METERPAL =
	process.env.RESEND_FROM ?? `MeterPal <hey@${process.env.RESEND_DOMAIN}>`;
export const FROM_AYUSH = `Ayush <ayush@${process.env.RESEND_DOMAIN}>`;
