import { AppEnv } from "@autumn/shared";
import { useEffect } from "react";
import { sandboxColorValue } from "@/hooks/sandbox/sandboxDisplay";
import { useActiveSandbox } from "@/hooks/sandbox/useActiveSandbox";
import { useEnv } from "@/utils/envUtils";

// The sandbox favicon is derived from the canonical mark at
// /meterpal-icon.svg (generated from assets/images/icon.svg). No copy of the
// paths lives here. The mark is dark ink, so it sits on a white plate inside a
// ring coloured with the sandbox tag colour.
const MARK_VIEWBOX = 1469; // viewBox of assets/images/icon.svg
const FAVICON_SIZE = 28;

/** Pull the inner markup out of the canonical SVG so we can nest it. */
const markInnerSvg = (svgText: string): string | null => {
	const open = svgText.search(/<svg[\s>]/);
	const close = svgText.lastIndexOf("</svg>");
	if (open === -1 || close === -1) return null;
	const openEnd = svgText.indexOf(">", open);
	if (openEnd === -1 || openEnd > close) return null;
	return svgText.slice(openEnd + 1, close);
};

const sandboxFaviconHref = (color: string, mark: string) =>
	`data:image/svg+xml,${encodeURIComponent(
		`<svg width="${FAVICON_SIZE}" height="${FAVICON_SIZE}" viewBox="0 0 ${FAVICON_SIZE} ${FAVICON_SIZE}" xmlns="http://www.w3.org/2000/svg">` +
			`<rect width="28" height="28" rx="6" fill="${color}"/>` +
			`<rect x="1" y="1" width="26" height="26" rx="5" fill="#ffffff"/>` +
			// Preserve the source's evenodd fill rule: its ring is a compound
			// path, and we drop the root <svg> style attribute when nesting.
			`<svg x="2" y="2" width="24" height="24" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}" fill-rule="evenodd" clip-rule="evenodd">${mark}</svg>` +
			`</svg>`,
	)}`;

// Matches --color-sandbox in packages/ui/src/styles/index.css, the brand
// light blue used by SandboxBanner when no sandbox-specific tag color is set.
const DEFAULT_SANDBOX_FAVICON_COLOR = "#00bfe4";

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
		let cancelled = false;

		fetch("/meterpal-icon.svg")
			.then((res) => {
				if (!res.ok) throw new Error("canonical mark unavailable");
				return res.text();
			})
			.then((text) => {
				const mark = markInnerSvg(text);
				if (cancelled || !mark) return;
				favicon.href = sandboxFaviconHref(color, mark);
			})
			.catch(() => {
				/* leave the standard MeterPal favicon in place */
			});

		return () => {
			cancelled = true;
			if (originalHref) favicon.setAttribute("href", originalHref);
			else favicon.removeAttribute("href");
		};
	}, [color]);

	return null;
};
