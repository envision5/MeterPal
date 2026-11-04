import chalk from "chalk";
import inquirer from "inquirer";

/**
 * Prompts user for Upstash configuration
 */
export async function setupUpstash(): Promise<{
	upstashUrl: string;
	upstashToken: string;
}> {
	console.log(
		chalk.magentaBright("\n================ Upstash Setup ================\n"),
	);
	console.log(
		chalk.cyan(
			"Upstash is used for caching the customer object and is important for testing race conditions.",
		),
	);
	console.log(
		chalk.cyan(
			"You can create a free Upstash Redis instance at https://upstash.com/\n",
		),
	);

	const { upstashUrl } = await inquirer.prompt([
		{
			type: "input",
			name: "upstashUrl",
			message: chalk.cyan("Enter your Upstash Redis REST URL:"),
			validate: (input: string) => {
				if (!input || input.length < 10) {
					return "Please enter a valid Upstash URL";
				}
				if (!input.startsWith("https://")) {
					return "Upstash URL should start with 'https://'";
				}
				return true;
			},
		},
	]);

	const { upstashToken } = await inquirer.prompt([
		{
			type: "input",
			name: "upstashToken",
			message: chalk.cyan("Enter your Upstash Redis REST token:"),
			validate: (input: string) => {
				if (!input || input.length < 10) {
					return "Please enter a valid Upstash token";
				}
				return true;
			},
		},
	]);

	return { upstashUrl, upstashToken };
}

/**
 * Prompts user for tunnel URL
 */
export async function setupTunnelUrl(): Promise<string> {
	console.log(
		chalk.magentaBright(
			"\n================ Tunnel URL Setup ================\n",
		),
	);
	console.log(
		chalk.cyan(
			"You need a tunnel that points to localhost:8080 (your server URL) to receive webhooks.",
		),
	);
	console.log(
		chalk.cyan(
			"You can use tools like ngrok, localtunnel, or Cloudflare Tunnel.",
		),
	);
	console.log(chalk.cyan("Example: https://your-subdomain.ngrok.io\n"));

	const { tunnelUrl } = await inquirer.prompt([
		{
			type: "input",
			name: "tunnelUrl",
			message: chalk.cyan("Enter your tunnel URL:"),
			validate: (input: string) => {
				if (!input || input.length < 10) {
					return "Please enter a valid tunnel URL";
				}
				if (!input.startsWith("https://") && !input.startsWith("http://")) {
					return "Tunnel URL should start with 'http://' or 'https://'";
				}
				return true;
			},
		},
	]);

	return tunnelUrl;
}
