import type { ChatConfig } from "@autumn/shared";
import { Switch } from "@autumn/ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useChatConfigQuery } from "@/hooks/queries/useChatConfigQuery";
import { getBackendErr } from "@/utils/genUtils";
import { SettingsSection } from "../SettingsSection";
import { SETTINGS_LIST_CLASS, SettingsGroup } from "../components/SettingsGroup";
import { SettingsListRow } from "../components/SettingsListRow";

/**
 * How the merchant's chat app answers its users.
 *
 * The one switch here is streaming, and it is ON by default: a streamed
 * answer shows its first token in milliseconds instead of after the whole
 * generation, and it is what lets a customer watch the wallet drain while
 * the call is in flight. A merchant turns it off when their client cannot
 * read an event stream.
 *
 * The switch saves immediately rather than behind a Save button — it is a
 * single boolean, and a merchant flipping it expects the app to behave
 * differently on the next message, not after a form submit.
 */
export const ChatSection = () => {
	const { config, isLoading, update, isUpdating } = useChatConfigQuery();
	const [streaming, setStreaming] = useState<boolean | null>(null);

	useEffect(() => {
		if (config) setStreaming(config.streaming);
	}, [config]);

	if (isLoading || streaming === null) {
		return (
			<SettingsSection title="Chat" description="Loading chat configuration…">
				<div className="h-24 animate-pulse rounded-lg bg-interactive-secondary" />
			</SettingsSection>
		);
	}

	const handleToggle = async (next: boolean) => {
		const previous = streaming;
		setStreaming(next);
		try {
			await update({ streaming: next } satisfies Partial<ChatConfig>);
			toast.success(
				next ? "Responses now stream" : "Responses now arrive in one piece",
			);
		} catch (error) {
			setStreaming(previous);
			toast.error(getBackendErr(error, "Failed to save chat configuration"));
		}
	};

	return (
		<SettingsSection
			title="Chat"
			description="How your app answers the people using it."
		>
			<SettingsGroup
				title="Responses"
				description="Applies to every message your app sends on a customer's behalf."
			>
				<div className={SETTINGS_LIST_CLASS}>
					<SettingsListRow
						title="Stream responses"
						description={
							<>
								Deliver tokens as the model produces them, so the first words
								appear immediately and the wallet visibly drains during the
								call. Turn this off if your client cannot read an event
								stream — the answer then arrives in one piece.
							</>
						}
					>
						<Switch
							checked={streaming}
							disabled={isUpdating}
							onCheckedChange={handleToggle}
							data-testid="streaming-toggle"
						/>
					</SettingsListRow>
				</div>
			</SettingsGroup>
		</SettingsSection>
	);
};
