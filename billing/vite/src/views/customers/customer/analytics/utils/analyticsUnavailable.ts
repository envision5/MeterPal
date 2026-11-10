import { ErrCode } from "@autumn/shared";

/**
 * The error codes that mean "this server cannot serve analytics".
 *
 * The server throws `analytics_not_configured` when the analytics backend is
 * absent, but older builds threw `tinybird_disabled` (and its deprecated alias
 * `ClickHouseDisabled`, which has the same string value). The dashboard used
 * to check only the latter, so a real "analytics unavailable" response fell
 * through the check and was swallowed as a generic error -- the page then
 * rendered its "no usage yet" empty state, which reads as "the customer has
 * not used anything" rather than "the server cannot answer".
 *
 * Both codes are accepted so either server version is handled.
 */
export const ANALYTICS_UNAVAILABLE_CODES: string[] = [
	ErrCode.AnalyticsNotConfigured,
	ErrCode.TinybirdDisabled,
];

/** True when an error means the analytics backend is unavailable. */
export const isAnalyticsUnavailableError = (error: unknown): boolean => {
	const code = (error as { code?: string } | null)?.code;
	return !!code && ANALYTICS_UNAVAILABLE_CODES.includes(code);
};

/** True when an axios error response carries an analytics-unavailable code. */
export const isAnalyticsUnavailableResponse = (error: unknown): boolean => {
	const code = (
		error as
			| { response?: { data?: { code?: string } } }
			| null
			| undefined
	)?.response?.data?.code;
	return !!code && ANALYTICS_UNAVAILABLE_CODES.includes(code);
};
