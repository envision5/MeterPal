#!/usr/bin/env node
// The `meterpal` command.  `meterpal init` wires MeterPal into the app it
// is run in: it detects the framework, writes the environment and the
// server-side handler, and prints the snippet to start from.
import { runInit } from "./init.js";

runInit(process.argv.slice(2))
	.then((code) => {
		process.exit(code);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
