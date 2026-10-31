import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutumnProvider } from "autumn-js/react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 2_000 } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<QueryClientProvider client={queryClient}>
			{/* Identity is resolved server-side from the x-meterpal-customer
			    header the demo app sends (see server.ts /api/autumn mount). */}
			<AutumnProvider backendUrl="">
				<App />
			</AutumnProvider>
		</QueryClientProvider>
	</React.StrictMode>,
);
