import type { WebhookAppKind } from "@autumn/shared";
import type { AutumnContext } from "@/honoUtils/HonoEnv.js";
import { ensureSvixAppId } from "../ensureSvixAppId.js";

export type WebhookApp = { kind: WebhookAppKind; appId: string };

/** Every app this env's webhooks can live in. */
export const listWebhookApps = async ({
	ctx,
}: {
	ctx: AutumnContext;
}): Promise<WebhookApp[]> => {
	const main = await ensureSvixAppId({ ctx });
	return [{ kind: "main", appId: main }];
};

/** The app a new webhook of this kind is written to, created if missing. */
export const ensureWebhookAppId = ({
	ctx,
}: {
	ctx: AutumnContext;
	kind: WebhookAppKind;
}): Promise<string> => ensureSvixAppId({ ctx });
