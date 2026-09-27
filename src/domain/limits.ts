/**
 * Server-enforced input size caps.
 *
 * These exist so a caller cannot make Meera pay for unbounded work.
 * They are constants, not request-derived values, and they are applied
 * BEFORE any parsing and BEFORE any payment can settle.
 */

/** Longest single notice we will even look at, in characters. */
export const MAX_NOTICE_CHARS = 4_000;

/** Most notices accepted in one bulk request. */
export const MAX_BULK_ITEMS = 25;

/** Longest raw body the JSON body parser will buffer, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024;
