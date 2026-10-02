/**
 * Pagination constants (#412).
 *
 * These are referenced by DTOs and repositories to enforce consistent limits
 * across all paginated endpoints.
 */

/** Default page size when the caller omits `limit`. */
export const DEFAULT_PAGE_SIZE = 25;

/** Hard maximum `limit` value to prevent oversized pages. */
export const MAX_PAGE_SIZE = 100;

/**
 * Hard maximum `offset` value.  Requests above this are rejected with 400.
 * Existing offset-based callers get a `Deprecation` response header.
 */
export const MAX_OFFSET = 10_000;

/**
 * Environment variable that holds the HMAC secret used by CursorCodec.
 * Falls back to a dev placeholder when unset (never use in production).
 */
export const CURSOR_SECRET_ENV = "CURSOR_HMAC_SECRET";

/** Returns the signing secret, with a safe dev fallback. */
export function getCursorSecret(): string {
  return process.env[CURSOR_SECRET_ENV] ?? "dev-cursor-hmac-secret-do-not-use-in-prod";
}
