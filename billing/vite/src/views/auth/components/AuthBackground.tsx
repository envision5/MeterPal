import type { ReactNode } from "react";
import { MeterPalWordmark } from "@/components/general/MeterPalWordmark";

interface AuthBackgroundProps {
	children: ReactNode;
}

/**
 * Split-screen auth layout: brand panel on left, content on right.
 * Clean border separation. Panel hidden on mobile.
 *
 * The panel is a CSS treatment in the MeterPal palette — dark-blue field,
 * yellow and light-blue glows — with the canonical mark as a large watermark,
 * so the first screen a merchant sees is on-brand. Both the mark and the
 * wordmark come from assets/images via scripts/sync-brand-assets.mjs.
 */
export function AuthBackground({ children }: AuthBackgroundProps) {
	return (
		<div className="h-screen bg-background flex">
			{/* Brand panel */}
			<div className="hidden lg:block relative w-1/2 overflow-hidden border-r border-border bg-[#001a52]">
				<div
					className="absolute inset-0"
					aria-hidden="true"
					style={{
						background: [
							"radial-gradient(ellipse 60% 45% at 78% 12%, rgba(96, 205, 255, 0.22), transparent 70%)",
							"radial-gradient(ellipse 55% 50% at 15% 85%, rgba(0, 140, 255, 0.20), transparent 70%)",
							"radial-gradient(ellipse 70% 60% at 45% 45%, rgba(0, 41, 145, 0.55), transparent 75%)",
							"linear-gradient(160deg, #001a52 10%, #002991 55%, #001f6b 100%)",
						].join(", "),
					}}
				/>
				<img
					src="/meterpal-icon.svg"
					alt=""
					aria-hidden="true"
					className="absolute -right-16 -bottom-20 w-[130%] opacity-[0.08] [filter:brightness(0)_invert(1)]"
				/>
				<div className="absolute inset-0 flex items-end p-8">
					<MeterPalWordmark variant="dark" className="h-7 w-auto opacity-80" />
				</div>
			</div>

			{/* Form panel */}
			<div className="w-full lg:w-1/2 flex items-center justify-center p-6">
				<div className="w-full max-w-[350px]">{children}</div>
			</div>
		</div>
	);
}
