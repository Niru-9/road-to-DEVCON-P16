/**
 * Shared request-reading helpers.
 *
 * Everything a caller sends passes through here first: shape check, then the
 * server's own size caps. A request that trips a cap is rejected with a 4xx
 * before any parsing work happens — and therefore long before any payment
 * could settle.
 */
import type { Request } from "express";
import { RequestRejectedError, excerptOf } from "../domain/errors.js";
import { MAX_BULK_ITEMS, MAX_NOTICE_CHARS } from "../domain/limits.js";

/** Pull a single notice string out of a request body, or reject the request. */
export function readNoticeField(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    throw new RequestRejectedError(400, "invalid-body", "expected a JSON object body");
  }
  const value = (body as Record<string, unknown>).notice;
  if (typeof value !== "string") {
    throw new RequestRejectedError(
      400,
      "invalid-body",
      'field "notice" is required and must be a string',
    );
  }
  if (value.trim().length === 0) {
    throw new RequestRejectedError(400, "empty-notice", 'field "notice" must not be empty');
  }
  if (value.length > MAX_NOTICE_CHARS) {
    throw new RequestRejectedError(
      413,
      "notice-too-large",
      `notice is ${value.length} characters; this server accepts at most ${MAX_NOTICE_CHARS}`,
    );
  }
  return value;
}

/** Pull a bounded list of notice strings out of a request body. */
export function readNoticeListField(body: unknown): string[] {
  if (typeof body !== "object" || body === null) {
    throw new RequestRejectedError(400, "invalid-body", "expected a JSON object body");
  }
  const value = (body as Record<string, unknown>).notices;
  if (!Array.isArray(value)) {
    throw new RequestRejectedError(
      400,
      "invalid-body",
      'field "notices" is required and must be an array of strings',
    );
  }
  if (value.length === 0) {
    throw new RequestRejectedError(400, "empty-notice-list", 'field "notices" must not be empty');
  }
  if (value.length > MAX_BULK_ITEMS) {
    throw new RequestRejectedError(
      413,
      "too-many-notices",
      `received ${value.length} notices; this server accepts at most ${MAX_BULK_ITEMS} per call`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new RequestRejectedError(
        400,
        "invalid-body",
        `notices[${index}] must be a string`,
      );
    }
    if (entry.trim().length === 0) {
      throw new RequestRejectedError(
        400,
        "empty-notice",
        `notices[${index}] must not be empty`,
      );
    }
    if (entry.length > MAX_NOTICE_CHARS) {
      throw new RequestRejectedError(
        413,
        "notice-too-large",
        `notices[${index}] is ${entry.length} characters; this server accepts at most ${MAX_NOTICE_CHARS}`,
      );
    }
    return entry;
  });
}

/** Log-friendly, body-safe echo of a rejected request. */
export function describeRejection(error: RequestRejectedError, body: unknown): string {
  const raw =
    typeof body === "object" && body !== null
      ? JSON.stringify(body).slice(0, 200)
      : String(body).slice(0, 200);
  return `${error.code}: ${error.detail} (body: ${excerptOf(raw)})`;
}
