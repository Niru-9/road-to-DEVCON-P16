/**
 * A tiny in-memory audit trail.
 *
 * x402 gives us the events that matter for trust — a payment was verified but
 * then cancelled because Meera could not read the notice, and a payment that
 * actually settled. Both are appended here so a reviewer can see, from the
 * server side, that an unreadable notice really does cost nothing.
 *
 * Deliberately in-memory: nothing here is sensitive enough to warrant a
 * database, and a restart should not pretend history is durable.
 */
export type AuditEvent =
  | {
      kind: "payment-canceled";
      reason: string;
      responseStatus: number | undefined;
      at: string;
    }  | {
      kind: "payment-settled";
      amount: string;
      payer: string;
      transaction: string;
      at: string;
    }
  | {
      kind: "notice-rejected";
      code: string;
      detail: string;
      at: string;
    };

const MAX_EVENTS = 200;
const events: AuditEvent[] = [];

/** A settlement record carries a real address; truncate it for display. */
function maskAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function recordSettlement(event: {
  amount: string;
  payer: string;
  transaction: string;
}): void {
  push({
    kind: "payment-settled",
    amount: event.amount,
    payer: maskAddress(event.payer),
    transaction: event.transaction,
    at: new Date().toISOString(),
  });
}

export function recordCancellation(event: {
  reason: string;
  responseStatus?: number | undefined;
}): void {
  push({
    kind: "payment-canceled",
    reason: event.reason,
    responseStatus: event.responseStatus,
    at: new Date().toISOString(),
  });
}

export function recordRejection(code: string, detail: string): void {
  push({ kind: "notice-rejected", code, detail, at: new Date().toISOString() });
}

function push(event: AuditEvent): void {
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
}

/** Most recent first. Exposed read-only at GET /v1/audit. */
export function recentEvents(limit = 20): AuditEvent[] {
  return events.slice(-limit).reverse();
}

export function resetAudit(): void {
  events.length = 0;
}
