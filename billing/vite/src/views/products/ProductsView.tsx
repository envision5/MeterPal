"use client";

import type { AppEnv } from "@autumn/shared";
import { PageContainer } from "@autumn/ui";
import { useEffect } from "react";
import { useAppQueryStates } from "@/hooks/common/useAppQueryStates";
import { useFeaturesQuery } from "@/hooks/queries/useFeaturesQuery";
import { useProductsQuery } from "@/hooks/queries/useProductsQuery";
import { useProductStore } from "@/hooks/stores/useProductStore";
import { useSheetCleanup } from "@/hooks/stores/useSheetStore";
import LoadingScreen from "../general/LoadingScreen";
import { FeaturesPage } from "./features/FeaturesPage";
import { ModelsPage } from "./models/ModelsPage";
import { ProductsContext } from "./ProductsContext";
import { ProductsPage } from "./products/ProductsPage";

function ProductsView({ env: _env }: { env: AppEnv }) {
	const { queryStates } = useAppQueryStates({
		defaultTab: "products",
	});

	useSheetCleanup();
	const resetProductStore = useProductStore((s) => s.reset);

	useEffect(() => {
		resetProductStore();
	}, [resetProductStore]);

	const { isLoading: isProductsLoading } = useProductsQuery();
	const { isLoading: isFeaturesLoading } = useFeaturesQuery();

	if (isProductsLoading || isFeaturesLoading) return <LoadingScreen />;

	const tab = queryStates.tab;
	return (
		<ProductsContext.Provider value={{}}>
			<PageContainer>
				{tab === "products" && <ProductsPage />}
				{tab === "features" && <FeaturesPage />}
				{tab === "models" && <ModelsPage />}
			</PageContainer>
		</ProductsContext.Provider>
	);
}

export default ProductsView;
