"use client";

import {
	Button,
	CopyTextButton,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	LongInput,
} from "@autumn/ui";
import { ChatCircleTextIcon } from "@phosphor-icons/react";
import { CircleQuestionMark, GraduationCap } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useAxiosInstance } from "@/services/useAxiosInstance";
import { useEnv } from "@/utils/envUtils";
import { pushPage } from "@/utils/genUtils";
import { useOnboardingVisibility } from "@/views/onboarding/hooks/useOnboardingProgress";
import { NavButton } from "./NavButton";

export function SidebarContact() {
	const email = "meterpal@envision5.com";
	const env = useEnv();
	const navigate = useNavigate();
	const { show: showOnboardingGuide } = useOnboardingVisibility();
	const axiosInstance = useAxiosInstance({ env });
	const [feedbackOpen, setFeedbackOpen] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [loading, setLoading] = useState(false);

	const handleSubmitFeedback = async () => {
		if (!feedback.trim()) return;

		setLoading(true);
		try {
			await axiosInstance.post("/feedback", { feedback });
			toast.success("Thanks for your feedback!");
			setFeedback("");
			setFeedbackOpen(false);
		} catch (error) {
			console.error("Failed to send feedback:", error);
			toast.error("Failed to send feedback");
		} finally {
			setLoading(false);
		}
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger render={<div />} nativeButton={false}>
					<NavButton
						env={env}
						icon={<CircleQuestionMark strokeWidth={1.5} />}
						title="Contact us"
						onClick={() => {}}
						isGroup
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="top" align="start">
					<span className="text-xs text-tertiary-foreground p-2">
						👋 We respond within 30 minutes
					</span>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={() => {
							window.location.href = `mailto:${email}`;
						}}
						className="cursor-pointer"
					>
						<div className="flex items-center justify-between w-full">
							<span>{email}</span>
							<CopyTextButton
								text={email}
								className="bg-transparent shadow-none hover:bg-zinc-200 w-6 gap-0 h-6 !px-0 py-0 flex items-center justify-center text-muted-foreground"
							/>
						</div>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={() => setFeedbackOpen(true)}
						className="cursor-pointer"
					>
						<ChatCircleTextIcon size={14} weight="duotone" />
						Feedback
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							showOnboardingGuide();
							pushPage({
								path: "/onboarding",
								navigate,
								preserveParams: false,
							});
						}}
						className="cursor-pointer"
					>
						<GraduationCap size={14} />
						Show onboarding guide
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Help us improve</DialogTitle>
						<DialogDescription>
							We read every comment, and often turn around features within a
							couple days. Be as brutal as you can - thank you so much!
						</DialogDescription>
					</DialogHeader>
					<LongInput
						value={feedback}
						onChange={(e) => setFeedback(e.target.value)}
						placeholder={`The worst part about MeterPal is...\n\nI really wish MeterPal had....\n\nThe part I found most confusing was...`}
						className="min-h-[120px]"
					/>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setFeedbackOpen(false)}>
							Cancel
						</Button>
						<Button
							variant="primary"
							onClick={handleSubmitFeedback}
							isLoading={loading}
							disabled={!feedback.trim()}
						>
							Send Feedback
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
