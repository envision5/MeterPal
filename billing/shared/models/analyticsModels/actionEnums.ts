export enum AuthType {
	Admin = "admin",
	SecretKey = "secret_key",
	PublicKey = "public_key",
	CustomerJwt = "customer_jwt",
	Dashboard = "dashboard",
	/**
	 * The hosted gateway.  It presents the shared gateway secret and names
	 * the tenant it resolved from the caller's virtual key.
	 */
	Gateway = "gateway",

	// Internal
	Vercel = "vercel",
	PayPal = "paypal",
	Unknown = "unknown",
	Worker = "worker",
}

export enum ActionType {
	CustomerCreated = "customer.created",
	CustomerProductsUpdated = "customer.products.updated",
	CustomerFeaturesUpdated = "customer.features.updated",
}
