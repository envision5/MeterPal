import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/cli/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	sourcemap: true,
	clean: true,
	external: ["react", "react-dom", "@tanstack/react-query", "autumn-js"],
});
