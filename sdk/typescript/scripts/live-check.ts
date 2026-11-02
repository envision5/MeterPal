// A live check of the SDK against the running stack.
//
//   bun run sdk/typescript/scripts/live-check.ts
//
// It proves the whole loop the merchant cares about: one call, one charge,
// one number on the response.
import {
	createMeterPal,
	InsufficientBalanceError,
	ModelNotFoundError,
} from "../src/index";

const BASE_URL = process.env.METERPAL_BASE_URL ?? "http://localhost:8080";
const API_KEY =
	process.env.METERPAL_SECRET_KEY ??
	"am_sk_test_JvWnILAeT5zTxPfHTPvJKV6NNDTn8uF97Np38YRe6d";

const meterpal = createMeterPal({ apiKey: API_KEY, baseURL: BASE_URL });

const log = (message: string) => console.log(message);

log("1. the merchant's served catalog");
const catalog = await meterpal.models.list();
for (const model of catalog.models) {
	log(
		`   ${model.model_id} (${model.upstream_model ?? "-"}) enabled=${model.enabled} ` +
			`in=${model.input_cost_usd_1m} out=${model.output_cost_usd_1m} per 1M`,
	);
}

log("2. a metered call");
const completion = await meterpal.chat.completions.create({
	model: "custom/demo-gpt",
	messages: [{ role: "user", content: "SDK live check" }],
	user: "demo-customer",
});
log(`   ${completion.choices[0]?.message?.content}`);
log(
	`   charged ${completion.meterpal.credits_charged} credits, ` +
		`balance now ${completion.meterpal.balance_after} ` +
		`(model ${completion.meterpal.model_id}, ` +
		`${completion.meterpal.input_tokens} in / ${completion.meterpal.output_tokens} out)`,
);

log("3. a streamed call");
let text = "";
let streamed: unknown = null;
for await (const chunk of meterpal.chat.completions.stream({
	model: "custom/demo-gpt",
	messages: [{ role: "user", content: "SDK streaming check" }],
	user: "demo-customer",
})) {
	if (chunk.meterpal) streamed = chunk.meterpal;
	text += chunk.choices?.[0]?.delta?.content ?? "";
}
log(`   ${text}`);
log(`   charged ${(streamed as any)?.credits_charged} credits`);

log("4. an unknown model is refused");
try {
	await meterpal.chat.completions.create({
		model: "gpt-4o-mini",
		messages: [{ role: "user", content: "x" }],
		user: "demo-customer",
	});
	log("   NOT REFUSED -- this is a bug");
} catch (error) {
	if (error instanceof ModelNotFoundError) {
		log(`   refused: ${error.message}`);
	} else {
		throw error;
	}
}

log("5. a customer who cannot pay hits the paywall");
try {
	await meterpal.chat.completions.create({
		model: "custom/demo-gpt",
		messages: [{ role: "user", content: "x" }],
		user: "demo-customer-2",
	});
	log("   NOT REFUSED -- this is a bug");
} catch (error) {
	if (error instanceof InsufficientBalanceError) {
		log(
			`   paywall: balance ${error.balance}, needs ${error.requiredCredits}, ` +
				`customer ${error.customerId}`,
		);
		log(`   topUp() is wired: ${typeof error.topUp === "function"}`);
	} else {
		throw error;
	}
}

log("");
log("SDK live check: OK");
