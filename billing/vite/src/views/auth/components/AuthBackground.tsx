import type { ReactNode } from "react";
import { MeterPalWordmark } from "./MeterPalWordmark";

interface AuthBackgroundProps {
	children: ReactNode;
}

/**
 * Split-screen auth layout: brand panel on left, content on right.
 * Clean border separation. Panel hidden on mobile.
 *
 * The panel is a CSS treatment in the MeterPal palette — dark-blue field,
 * yellow and light-blue glows, and the mark as a large watermark — rather
 * than a stock photo, so the first screen a merchant sees is on-brand.
 */
export function AuthBackground({ children }: AuthBackgroundProps) {
	return (
		<div className="h-screen bg-background flex">
			{/* Brand panel */}
			<div className="hidden lg:block relative w-1/2 overflow-hidden border-r border-border bg-[#0d1b3d]">
				<div
					className="absolute inset-0"
					aria-hidden="true"
					style={{
						background: [
							"radial-gradient(ellipse 60% 45% at 78% 12%, rgba(244, 191, 61, 0.22), transparent 70%)",
							"radial-gradient(ellipse 55% 50% at 15% 85%, rgba(0, 191, 228, 0.18), transparent 70%)",
							"radial-gradient(ellipse 70% 60% at 45% 45%, rgba(38, 64, 130, 0.55), transparent 75%)",
							"linear-gradient(160deg, #0d1b3d 10%, #264082 55%, #1a2c5c 100%)",
						].join(", "),
					}}
				/>
				<svg
					viewBox="0 0 805 805"
					aria-hidden="true"
					className="absolute -right-16 -bottom-20 w-[130%] opacity-[0.08]"
				>
					<g transform="scale(1.05)">
						<path
							d="M587.256,303.265l-211.15,0c-27.647,0 -53.213,14.672 -67.167,38.533l-93.023,159.104l208.577,-0c29.239,-0 56.286,-15.515 71.043,-40.759l91.72,-156.878Z"
							fill="#f4bf3d"
						/>
						<path
							d="M215.916,500.902l93.023,-159.104c-37.52,64.179 -114.356,195.596 -171.774,293.812c-14.784,25.283 -14.91,56.543 -0.336,81.951c14.573,25.401 41.627,41.068 70.912,41.068l342.739,-0c29.239,-0 56.286,-15.515 71.043,-40.759c38.238,-65.396 114.765,-196.287 171.65,-293.594c14.54,-24.875 14.665,-55.621 0.329,-80.608c-14.337,-24.993 -40.943,-40.403 -69.754,-40.403l-347.642,0l211.15,0l-91.72,156.878c-14.757,25.244 -41.804,40.759 -71.043,40.759l-208.577,-0Z"
							fill="#ffffff"
						/>
						<path
							d="M215.916,500.902l93.023,-159.104c13.954,-23.861 39.52,-38.533 67.167,-38.533l211.15,0l-83.979,143.641l163.909,-280.357c14.54,-24.875 14.665,-55.621 0.329,-80.608c-14.337,-24.994 -40.943,-40.403 -69.754,-40.403l-347.643,0c-27.646,0 -53.218,14.672 -67.166,38.533c-37.52,64.179 -114.356,195.596 -171.774,293.812c-14.784,25.283 -14.91,56.543 -0.336,81.944c14.573,25.408 41.627,41.075 70.912,41.075l134.162,-0Z"
							fill="#ffffff"
						/>
					</g>
				</svg>
				<div className="absolute inset-0 flex items-end p-8">
					<MeterPalWordmark className="h-7 w-auto text-white/80" />
				</div>
			</div>

			{/* Form panel */}
			<div className="w-full lg:w-1/2 flex items-center justify-center p-6">
				<div className="w-full max-w-[350px]">{children}</div>
			</div>
		</div>
	);
}
