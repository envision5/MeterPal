/** biome-ignore-all lint/suspicious/noExplicitAny: can use any*/

type CustomButtonCustomer = { id?: string | null; email?: string | null };

const CUSTOM_BUTTON_VARS: Record<
	string,
	(customer: CustomButtonCustomer) => string
> = {
	"{customerId}": (customer) => customer.id ?? "",
	"{customerEmail}": (customer) => customer.email ?? "",
};

// mailto:/tel: recipients are not URL path/query segments — per RFC 6068 the
// `@` in an address must stay literal, so percent-encoding would break them.
const NON_ENCODED_SCHEMES = /^(mailto|tel):/i;

export const resolveCustomButtonUrl = (
	template: string,
	customer: CustomButtonCustomer,
) => {
	const encode = NON_ENCODED_SCHEMES.test(template)
		? (value: string) => value
		: encodeURIComponent;
	let resolved = template;
	for (const [token, getValue] of Object.entries(CUSTOM_BUTTON_VARS)) {
		resolved = resolved.replaceAll(token, encode(getValue(customer)));
	}
	return resolved;
};

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export const isSafeCustomButtonUrl = (url: string) => {
	try {
		return SAFE_PROTOCOLS.has(new URL(url).protocol);
	} catch {
		return false;
	}
};
