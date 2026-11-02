/**
 * `meterpal init` -- the wiring logic.
 *
 * Kept separate from the bin entry so it can be called directly (from a
 * test, or from another tool) without the process exiting underneath it.
 *
 * It must not require infrastructure: no Docker, no gateway, no database.
 * The merchant runs their existing app.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	detectFramework,
	handlerPath,
	type Framework,
	templateFor,
} from "./frameworks.js";

const DEFAULT_API_URL = "https://api.meterpal.dev";

export type InitOptions = {
	/** The merchant's MeterPal secret key. */
	apiKey?: string;
	/** The MeterPal API. */
	apiUrl: string;
	/** Never prompt. */
	yes: boolean;
	/** Print what would change, change nothing. */
	dryRun: boolean;
	/** The app to wire up. */
	cwd: string;
};

export const parseArgs = (argv: string[]): InitOptions => {
	const options: InitOptions = {
		apiUrl: DEFAULT_API_URL,
		yes: false,
		dryRun: false,
		cwd: process.cwd(),
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--api-key") options.apiKey = argv[++i];
		else if (arg === "--api-url") options.apiUrl = argv[++i] ?? DEFAULT_API_URL;
		else if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--cwd") options.cwd = resolve(argv[++i] ?? ".");
	}

	return options;
};

const readDependencies = (cwd: string): Record<string, string> => {
	const path = join(cwd, "package.json");
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return {
			...(parsed.dependencies ?? {}),
			...(parsed.devDependencies ?? {}),
		};
	} catch {
		return {};
	}
};

/** Ask a question on the terminal. */
const ask = async (question: string): Promise<string> => {
	const readline = await import("node:readline/promises");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = await rl.question(question);
		return answer.trim();
	} finally {
		rl.close();
	}
};

/** Add or replace a key in an env file. */
const upsertEnv = (contents: string, key: string, value: string): string => {
	const line = `${key}=${value}`;
	const pattern = new RegExp(`^${key}=.*$`, "m");
	if (pattern.test(contents)) return contents.replace(pattern, line);
	const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
	return `${contents}${separator}${line}\n`;
};

const writeFile = (path: string, contents: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf8");
};

export const runInit = async (argv: string[]): Promise<number> => {
	const options = parseArgs(argv);
	const log = (message: string) => console.log(message);

	log("");
	log("  MeterPal — usage-based AI billing for your app");
	log("  --------------------------------------------");

	// 1. framework
	const dependencies = readDependencies(options.cwd);
	const detection = detectFramework(dependencies);
	const framework: Framework = detection.framework;
	log(
		`  Framework: ${framework}${
			detection.matched
				? ` (found ${detection.matched})`
				: " (no guess — using a plain fetch handler)"
		}`,
	);

	// 2. the secret key
	let apiKey = options.apiKey;
	if (!apiKey) {
		if (options.yes) {
			log("  No --api-key given and --yes was passed: skipping the key.");
		} else {
			log("");
			log("  Get your secret key from the MeterPal dashboard:");
			log("    https://app.meterpal.dev/settings/api-keys");
			log("");
			apiKey = await ask("  MeterPal secret key (am_sk_...): ");
		}
	}

	// 3. the environment
	const envFileName = framework === "next" ? ".env.local" : ".env";
	const envPath = join(options.cwd, envFileName);
	let envContents = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
	envContents = upsertEnv(envContents, "METERPAL_SECRET_KEY", apiKey ?? "");
	envContents = upsertEnv(envContents, "METERPAL_API_URL", options.apiUrl);
	envContents = upsertEnv(
		envContents,
		"METERPAL_BASE_URL",
		options.apiUrl.replace(/\/v1\/?$/, ""),
	);

	// 4. the handler
	const handler = handlerPath(framework);
	const handlerFile = join(options.cwd, handler);
	const handlerExists = existsSync(handlerFile);

	if (options.dryRun) {
		log("");
		log(`  Would write ${envFileName}:`);
		log(envContents.trimEnd());
		log("");
		log(
			`  Would write ${handler}${
				handlerExists ? " (already exists — left alone)" : ""
			}:`,
		);
		if (!handlerExists) log(templateFor(framework).trimEnd());
		log("");
		return 0;
	}

	writeFile(envPath, envContents);
	log(`  Wrote ${envFileName}`);

	if (handlerExists) {
		log(`  Skipped ${handler} (already exists)`);
	} else {
		writeFile(handlerFile, templateFor(framework));
		log(`  Wrote ${handler}`);
	}

	// 5. the snippet and the dashboard
	log("");
	log("  Now call it:");
	log("");
	log(`	import { createMeterPal } from "@meterpal/sdk";`);
	log("");
	log(`	const meterpal = createMeterPal({`);
	log(`		apiKey: process.env.METERPAL_SECRET_KEY!,`);
	log(`		baseURL: process.env.METERPAL_BASE_URL,`);
	log(`	});`);
	log("");
	log(`	const completion = await meterpal.chat.completions.create({`);
	log(`		model: "custom/demo-gpt",`);
	log(`		messages: [{ role: "user", content: "Hello" }],`);
	log(`		user: "cus_123",   // the end user being billed`);
	log(`	});`);
	log(`	completion.meterpal.credits_charged;   // what the call cost`);
	log("");
	log("  Watch usage as it happens: https://app.meterpal.dev/dashboard");
	log("");

	if (!apiKey) {
		log("  Add METERPAL_SECRET_KEY to your environment before you start.");
		log("");
	}

	return 0;
};
