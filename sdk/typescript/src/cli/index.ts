#!/usr/bin/env node
// The `meterpal` command.  `meterpal init` wires MeterPal into the app it
// is run in: it detects the framework, writes the environment and the
// server-side handler, and prints the snippet to start from.
//
// Everything here is argument dispatch.  The wiring itself lives in
// ./init.ts, which stays callable without this process exiting underneath
// it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInit } from "./init.js";

const USAGE = `meterpal — usage-based AI billing for your app

Usage:
  meterpal init [options]        Wire MeterPal into the app in --cwd

Options:
  --api-key <key>   MeterPal secret key (am_sk_...). Prompts when omitted.
  --api-url <url>   MeterPal API base. Defaults to $METERPAL_API_URL, then
                    https://api.meterpal.dev. For this repo's local stack:
                    --api-url http://localhost:8080
  --yes, -y         Never prompt. Skips the key when --api-key is absent.
  --dry-run         Print what would change, write nothing.
  --cwd <dir>       The app to wire up. Defaults to the current directory.
  --help, -h        Show this message.
  --version, -v     Show the version.

Local testing against this repo's stack:
  meterpal init --yes --api-url http://localhost:8080 --cwd ../my-app
  then set METERPAL_SECRET_KEY to PAB_API_KEY from gateway/.env.
`;

/** The version tsup shipped next to this file, or a safe placeholder. */
const readVersion = (): string => {
	try {
		const path = fileURLToPath(new URL("../../package.json", import.meta.url));
		return JSON.parse(readFileSync(path, "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
};

const main = async (argv: string[]): Promise<number> => {
	// `help` and `--help` win wherever they appear: a user asking for help
	// must never be dropped into an interactive prompt instead.
	if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
		console.log(USAGE);
		return 0;
	}
	if (argv.includes("--version") || argv.includes("-v")) {
		console.log(readVersion());
		return 0;
	}

	const [first, ...rest] = argv;

	// `meterpal init ...`, and the flag-first shorthand `meterpal --api-key ...`
	// that earlier docs used.  Both mean init.
	if (first === "init") return runInit(rest);
	if (first === undefined || first.startsWith("-")) return runInit(argv);

	console.error(`meterpal: unknown command "${first}"`);
	console.error("");
	console.error(USAGE);
	return 2;
};

main(process.argv.slice(2))
	.then((code) => {
		process.exit(code);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
