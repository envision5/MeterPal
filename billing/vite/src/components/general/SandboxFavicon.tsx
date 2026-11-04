import { AppEnv } from "@autumn/shared";
import { useEffect } from "react";
import { sandboxColorValue } from "@/hooks/sandbox/sandboxDisplay";
import { useActiveSandbox } from "@/hooks/sandbox/useActiveSandbox";
import { useEnv } from "@/utils/envUtils";

// The official MeterPal mark (assets/images/icon.svg), drawn in the favicon's
// 28x28 coordinate space via a 805 -> 28 scale.
const MARK_PATHS: Array<{ d: string; fill: string }> = [
	{
		d: "M587.256,303.265l-211.15,0c-27.647,0 -53.213,14.672 -67.167,38.533l-93.023,159.104l208.577,-0c29.239,-0 56.286,-15.515 71.043,-40.759l91.72,-156.878Z",
		fill: "#ee3e36",
	},
	{
		d: "M215.916,500.902l93.023,-159.104c-37.52,64.179 -114.356,195.596 -171.774,293.812c-14.784,25.283 -14.91,56.543 -0.336,81.951c14.573,25.401 41.627,41.068 70.912,41.068l342.739,-0c29.239,-0 56.286,-15.515 71.043,-40.759c38.238,-65.396 114.765,-196.287 171.65,-293.594c14.54,-24.875 14.665,-55.621 0.329,-80.608c-14.337,-24.993 -40.943,-40.403 -69.754,-40.403l-347.642,0l211.15,0l-91.72,156.878c-14.757,25.244 -41.804,40.759 -71.043,40.759l-208.577,-0Z",
		fill: "#264082",
	},
	{
		d: "M215.916,500.902l93.023,-159.104c13.954,-23.861 39.52,-38.533 67.167,-38.533l211.15,0l-83.979,143.641l163.909,-280.357c14.54,-24.875 14.665,-55.621 0.329,-80.608c-14.337,-24.994 -40.943,-40.403 -69.754,-40.403l-347.643,0c-27.646,0 -53.218,14.672 -67.166,38.533c-37.52,64.179 -114.356,195.596 -171.774,293.812c-14.784,25.283 -14.91,56.543 -0.336,81.944c14.573,25.408 41.627,41.075 70.912,41.075l134.162,-0Z",
		fill: "#f4bf3d",
	},
	{
		d: "M8.36,455.16l122.314,249.012c-7.958,-22.459 -5.786,-47.571 6.491,-68.562l78.751,-134.708l-134.162,-0c-29.285,-0 -56.339,-15.667 -70.912,-41.075c-0.882,-1.533 -1.712,-3.087 -2.482,-4.667Zm-0.125,-0.25l0.125,0.25l-0.125,-0.25Z",
		fill: "#00bfe4",
	},
	{
		d: "M672.037,95.123l110.202,233.366c-15.008,-15.897 -36.084,-25.224 -58.491,-25.224l-136.492,0l79.93,-136.716c12.802,-21.9 14.428,-48.354 4.851,-71.426Z",
		fill: "#00bfe4",
	},
];

const markSvg = () =>
	`<g transform="scale(0.03478)">${MARK_PATHS.map(
		(p) => `<path d="${p.d}" fill="${p.fill}"/>`,
	).join("")}</g>`;

// Matches --color-sandbox in packages/ui/src/styles/index.css, the brand
// light blue used by SandboxBanner when no sandbox-specific tag color is set.
const DEFAULT_SANDBOX_FAVICON_COLOR = "#00bfe4";

const sandboxFaviconHref = (color: string) =>
	`data:image/svg+xml,${encodeURIComponent(
		`<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg"><rect width="28" height="28" rx="6" fill="${color}"/><rect x="1" y="1" width="26" height="26" rx="5" fill="#264082"/>${markSvg()}</svg>`,
	)}`;

export const SandboxFavicon = () => {
	const env = useEnv();
	const activeSandbox = useActiveSandbox();
	const color =
		env === AppEnv.Sandbox
			? activeSandbox?.color
				? sandboxColorValue(activeSandbox.color)
				: DEFAULT_SANDBOX_FAVICON_COLOR
			: undefined;

	useEffect(() => {
		if (!color) return;

		const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
		if (!favicon) return;

		const originalHref = favicon.getAttribute("href");
		favicon.href = sandboxFaviconHref(color);

		return () => {
			if (originalHref) favicon.setAttribute("href", originalHref);
			else favicon.removeAttribute("href");
		};
	}, [color]);

	return null;
};
