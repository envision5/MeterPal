import { useCustomer } from "autumn-js/react";
import { useEffect } from "react";
import { useLocalStorage } from "@/hooks/common/useLocalStorage";
import { notNullish } from "@/utils/genUtils";

export const useAutumnFlags = () => {
	const { data: customer } = useCustomer();

	const [flags, setFlags] = useLocalStorage("autumn.flags", {
		pkey: false,
		platform: false,
		sso: false,
	});

	useEffect(() => {
		if (!customer?.flags) return;

		const nextFlags = {
			pkey: notNullish(customer.flags.pkey),
			platform: notNullish(customer.flags.platform),
			sso: notNullish(customer.flags.sso),
		};

		// Only update storage/state when values actually change
		if (
			flags.pkey !== nextFlags.pkey ||
			flags.platform !== nextFlags.platform ||
			flags.sso !== nextFlags.sso
		) {
			setFlags(nextFlags);
		}
	}, [customer?.flags]);

	// Webhooks have been released publicly — always on.
	return { ...flags, webhooks: true as const };
};
