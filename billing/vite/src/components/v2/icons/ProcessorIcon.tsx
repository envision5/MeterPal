import { ProcessorType } from "@autumn/shared";
import { CoinVerticalIcon } from "@phosphor-icons/react";

type ProcessorVariant = ProcessorType;

type ProcessorIconProps = {
	processor: ProcessorVariant;
	size?: number;
	className?: string;
};

export function ProcessorIcon({
	processor,
	size = 14,
	className,
}: ProcessorIconProps) {
	if (processor === ProcessorType.PayPal) {
		// PayPal's double-P monogram (simplified single path, filled).
		return (
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				width={size}
				height={size}
				className={className}
				fill="currentColor"
			>
				<title>PayPal</title>
				<path d="M7.1 21.3H4.6c-.4 0-.7-.4-.6-.8L7.6 1.9c.1-.5.5-.8 1-.8h6.1c3.2 0 5.5 1.1 6.4 3.2.9 2 .6 4.2-.9 6.6-1.5 2.5-4.2 4.3-7.6 4.3H9.9c-.5 0-.9.3-1 .8l-1 6.2c-.1.4-.4.6-.8.6Zm3.5-9.2h1.9c2 0 3.5-.9 4.3-2.5.6-1.1.7-2.2.3-3.1-.5-1-1.7-1.5-3.4-1.5h-1.9l-1.2 7.1Zm-3.9 10.6H4.2c-.4 0-.7-.4-.6-.8L6.2 13c.1-.4.4-.6.8-.6h2.6c-.4 2.6.3 5.1 2.2 6.9 1.3 1.3 3.1 2 5.1 2 .4 0 .8 0 1.1-.1-1.4 1.7-3.7 2.8-6.4 2.8H9.5c-.4 0-.7-.2-.8-.6l-.6-2.6Z" />
			</svg>
		);
	}

	return <CoinVerticalIcon size={size} weight="fill" className={className} />;
}
