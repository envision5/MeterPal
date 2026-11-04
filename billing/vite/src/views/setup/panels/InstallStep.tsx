// billing/vite/src/views/setup/panels/InstallStep.tsx
//
// The wizard's install step.
//
// The secret key is only ever shown once, when it is created -- so the
// wizard does not pretend it can print a key it does not hold.  It shows the
// command, the snippet, and where to create the key.

import { Button, CopyButton } from "@autumn/ui";
import { useNavigate } from "react-router";

/** The server-side handler the SDK generates. The key never reaches the browser. */
const SNIPPET = `import { createMeterPal } from "@meterpal/sdk";

// On your server only. The key never goes in the browser.
const meterpal = createMeterPal({
  apiKey: process.env.METERPAL_SECRET_KEY,
});

const reply = await meterpal.chat.completions.create({
  model: "custom/demo-gpt",
  messages: [{ role: "user", content: "Hello" }],
});`;

function CodeBlock({ text, label }: { text: string; label: string }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-subtle text-tiny">{label}</span>
				<CopyButton text={text} variant="muted" size="sm">
					Copy
				</CopyButton>
			</div>
			<pre className="overflow-x-auto rounded-lg border bg-interactive-secondary px-3 py-2.5 font-mono text-subtle text-xs">
				{text}
			</pre>
		</div>
	);
}

export function InstallStep({ apiUrl }: { apiUrl: string }) {
	const navigate = useNavigate();

	return (
		<div className="flex flex-col gap-4">
			<CodeBlock label="Install the SDK" text="npm install @meterpal/sdk" />

			<CodeBlock
				label="Or let your coding agent do it"
				text={`npx @meterpal/sdk init --api-url ${apiUrl}`}
			/>

			<CodeBlock label="Your server" text={SNIPPET} />

			<div className="rounded-lg border bg-interactive-secondary px-4 py-3">
				<p className="font-medium text-foreground text-sm">
					You need a secret key
				</p>
				<p className="mt-1 text-subtle text-xs">
					Create one in Developer settings. It is shown once, so copy it
					into your server's environment as{" "}
					<code className="font-mono">METERPAL_SECRET_KEY</code>.
				</p>
				<Button
					variant="secondary"
					size="sm"
					className="mt-3"
					onClick={() => navigate("/dev?tab=api_keys")}
				>
					Create a secret key
				</Button>
			</div>
		</div>
	);
}
