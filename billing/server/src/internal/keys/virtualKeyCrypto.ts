// billing/server/src/internal/keys/virtualKeyCrypto.ts
//
// At-rest handling for customer virtual keys (`customers.litellm_virtual_key`).
//
// The key is a live LiteLLM credential for one end customer.  It used to sit
// in the customers table as plaintext — the one credential in the system
// stored raw — so a database read or backup exposed every customer's
// gateway key.  It is now stored with deterministic encryption
// (`encryptDataDeterministic`): same key in, same ciphertext out, so the
// auth path can still find the customer row by equality while the value at
// rest is not the key.
//
// Legacy rows hold the plaintext (values starting with the `sk-` prefix are
// unambiguous — base64 ciphertext cannot start with "-").  Reads decrypt;
// a legacy plaintext passes through and the auth path upgrades the row
// lazily on first successful lookup.

import { decryptData, encryptDataDeterministic } from "@/utils/encryptUtils.js";

const LEGACY_PLAINTEXT_PREFIX = "sk-";

/** Encrypt a virtual key for at-rest storage. */
export const encryptVirtualKey = (key: string): string =>
	encryptDataDeterministic(key);

/**
 * Decrypt a stored virtual key.
 *
 * Returns null when the value can neither be decrypted nor recognized as a
 * legacy plaintext key (corrupted row).  Legacy plaintext passes through so
 * pre-upgrade rows keep working before their lazy rewrite.
 */
export const decryptVirtualKey = (
	value: string | null | undefined,
): string | null => {
	if (!value) return null;
	if (value.startsWith(LEGACY_PLAINTEXT_PREFIX)) return value;
	try {
		return decryptData(value);
	} catch {
		return null;
	}
};
