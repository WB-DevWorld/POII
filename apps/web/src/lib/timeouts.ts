// How long the web app waits for the API. Without a limit, one stuck call shows as a page that loads for ever.

/** Ordinary reads and writes. */
export const API_TIMEOUT_MS = 15_000;

/**
 * Calls that may legitimately run for minutes: an AI execution (the API waits up to POII_AI_TIMEOUT_MS,
 * at most 900 s, for the provider), backup, restore, import and export. Longer than the API's own limits,
 * so the API's answer wins whenever there is one.
 */
export const API_LONG_TIMEOUT_MS = 930_000;

/** The proxy's "who is signed in" check before every page. On a timeout the page renders its own notice. */
export const API_SESSION_CHECK_TIMEOUT_MS = 5_000;
