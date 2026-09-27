/**
 * Parse failures are a first-class, expected outcome — not an exception.
 *
 * A ParseFailure is what the handler turns into a 4xx. It carries the
 * individual reasons so Meera (and the caller) can see exactly which part of
 * the notice she could not read.
 */

export type ParseFailure = {
  readonly kind: "parse-failure";
  readonly reasons: readonly string[];
  readonly excerpt: string;
};

/** Thrown by the parser; always caught by the route handler. */
export class NoticeUnparseableError extends Error {
  readonly failure: ParseFailure;

  constructor(failure: ParseFailure) {
    super(`notice is unreadable: ${failure.reasons.join("; ")}`);
    this.name = "NoticeUnparseableError";
    this.failure = failure;
  }
}

/** Request rejected before parsing: too big, wrong shape, wrong count. */
export class RequestRejectedError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(status: number, code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RequestRejectedError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A short, human-readable quote of the input, for an error message.
 *
 * Whitespace-only input collapses to an empty string, which is useless in a
 * message a human is about to read — so say what it actually was instead of
 * returning nothing.
 */
export function excerptOf(input: string, max = 160): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return `(empty — ${input.length} whitespace character${input.length === 1 ? "" : "s"})`;
  }
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
