import { Button, Input } from "@autumn/ui";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { CustomToaster } from "@/components/general/CustomToaster";
import { authClient, useSession } from "@/lib/auth-client";
import { emailRegex } from "../SignIn";

export const PasswordSignIn = () => {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	const [googleLoading, setGoogleLoading] = useState(false);
	const [loading, setLoading] = useState(false);
	const { data: session } = useSession();

	const [searchParams] = useSearchParams();

	useEffect(() => {
		if (session?.user) {
			window.location.href = "/";
		}
	}, [session]);

	const handleEmailSignIn = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!email || !emailRegex.test(email)) {
			toast.error("Please enter a valid email address.");
			return;
		}
		setLoading(true);

		try {
			const { data, error } = await authClient.signIn.email({
				email: email,
				password: password,
			});

			if (error) {
				toast.error(error.message || "Something went wrong. Please try again.");
			} else {
				window.location.href = "/";
			}
		} catch (error) {
			toast.error("Something went wrong. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	const height = "h-9";

	return (
		<div className="w-screen h-screen bg-background flex items-center justify-center p-4">
			<CustomToaster />
			<div className="w-full max-w-[350px] space-y-4">
			{/* Logo — canonical mark from assets/images/icon.svg */}
			<div className="flex justify-center">
				<img
					src="/meterpal-icon.svg"
					alt="MeterPal"
					className="size-12 rounded-xl bg-white object-contain p-1"
				/>
			</div>

				{/* Title */}
				<div className="text-center">
					<h1 className="text-lg font-semibold text-foreground">
						Sign in to MeterPal
					</h1>
				</div>

				<div className="space-y-6">
					<div className="space-y-2">
						<Input
							type="email"
							placeholder="Email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							className="text-base"
							autoComplete="email"
						/>
						<Input
							type="password"
							placeholder="Password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							className="text-base"
							autoComplete="email"
						/>
					</div>

					{/* Sign In Button */}
					<Button
						type="submit"
						variant="secondary"
						isLoading={loading}
						onClick={handleEmailSignIn}
						className={`w-full ${height}`}
					>
						Sign in
					</Button>
				</div>

				{/* Footer */}
				{/* <div className="text-center space-y-2">
              <Link to="/sign-up" className="hover:underline text-tertiary-foreground text-sm">
                Create an account here
              </Link>
            </div> */}
			</div>
		</div>
	);
};
