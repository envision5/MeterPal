import { MeterPalLogo } from "@/components/icons/AutumnLogo";
import { cn } from "@/lib/utils";

const transitionClass = "transition-all duration-300";

export function CheckoutFooter() {
	return (
		<div
			className={cn(
				"w-fit mx-auto flex items-center justify-center gap-1.5",
				transitionClass,
			)}
		>
			<span className={cn("text-xs text-muted-foreground", transitionClass)}>
				Powered by
			</span>
			<MeterPalLogo className={cn("h-4 w-auto", transitionClass)} />
		</div>
	);
}
