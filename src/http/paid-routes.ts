/**
 * The two paid routes.
 *
 * Both handlers are mounted BEHIND the x402 middleware, so by the time
 * `handler` is invoked a payment has been verified but not yet settled.
 *
 * Every non-2xx exit from a handler is what releases that payment:
 *
 *   unreadable notice  -> 422  ->  x402 cancels the verified payment
 *   over the size cap  -> 413  ->  x402 cancels the verified payment
 *   malformed body     -> 400  ->  x402 cancels the verified payment
 *   everything parsed  -> 200  ->  x402 settles
 *
 * That is the whole product promise, and it depends on the `authorization`
 * payment flow (the `exact` scheme default). Do not add `paymentFlow: "upfront"`
 * to the route config in src/payment/x402.ts — it would settle first and turn
 * every 4xx above into a charge for work Meera never did.
 */
import { Router } from "express";
import { safeParseNotice } from "../domain/parser.js";
import { excerptOf } from "../domain/errors.js";
import { parsedNoticeSchema, type ParsedNotice } from "../domain/schema.js";
import { recordRejection } from "./audit.js";
import { readNoticeField, readNoticeListField } from "./request.js";
import { sendRejection } from "./free-routes.js";

export function buildPaidRouter(): Router {
  const router = Router();

  /**
   * POST /v1/parse — one notice, PRICE_SINGLE_BASE_UNITS.
   */
  router.post("/v1/parse", (req, res) => {
    let raw: string;
    try {
      raw = readNoticeField(req.body);
    } catch (error) {
      recordRejection("invalid-body", error instanceof Error ? error.message : "unknown");
      sendRejection(res, error, req.body);
      return;
    }

    const outcome = safeParseNotice(raw);
    if (!outcome.ok) {
      // 422 is a 4xx, so the verified payment is released. This is the single
      // most important line in the product.
      recordRejection("unparseable-notice", outcome.failure.reasons.join("; "));
      res.status(422).json({
        ok: false,
        error: "unparseable-notice",
        charged: false,
        detail:
          "This notice could not be read, so no payment was taken. Train number, station and expected time are all required.",
        reasons: outcome.failure.reasons,
        excerpt: outcome.failure.excerpt,
      });
      return;
    }

    // The declared output schema is the last gate before a 200. If the parser
    // ever produces a shape the schema does not accept, fail loudly rather
    // than shipping a malformed object to a caller who has been charged.
    const parsed = parsedNoticeSchema.safeParse(outcome.notice);
    if (!parsed.success) {
      recordRejection("schema-mismatch", parsed.error.issues.map((i) => i.path.join(".")).join("; "));
      res.status(422).json({
        ok: false,
        error: "schema-mismatch",
        charged: false,
        detail: "The parse did not match the declared output schema, so no payment was taken.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    res.json({ ok: true, charged: true, notice: parsed.data });
  });

  /**
   * POST /v1/parse/bulk — up to MAX_BULK_ITEMS notices for one flat price.
   *
   * Bulk is all-or-nothing on purpose. Returning a partial result and taking
   * the money would mean the caller paid in full for a response they cannot
   * use. If anything in the batch is unreadable, the whole call fails with a
   * 422 listing the offending items and the payment is released.
   */
  router.post("/v1/parse/bulk", (req, res) => {
    let rawList: string[];
    try {
      rawList = readNoticeListField(req.body);
    } catch (error) {
      recordRejection("invalid-body", error instanceof Error ? error.message : "unknown");
      sendRejection(res, error, req.body);
      return;
    }

    const parsed: ParsedNotice[] = [];
    const failed: { noticeIndex: number; reasons: string[]; excerpt: string }[] = [];

    rawList.forEach((raw, noticeIndex) => {
      const outcome = safeParseNotice(raw);
      if (outcome.ok) {
        const checked = parsedNoticeSchema.safeParse(outcome.notice);
        if (checked.success) {
          parsed.push(checked.data);
        } else {
          failed.push({
            noticeIndex,
            reasons: ["parse result did not match the declared output schema"],
            excerpt: excerptOf(raw),
          });
        }
        return;
      }
      failed.push({
        noticeIndex,
        reasons: [...outcome.failure.reasons],
        excerpt: outcome.failure.excerpt,
      });
    });

    if (failed.length > 0) {
      recordRejection("bulk-contains-unreadable", `${failed.length} of ${rawList.length} unreadable`);
      res.status(422).json({
        ok: false,
        error: "bulk-contains-unreadable",
        charged: false,
        detail: `No payment was taken: ${failed.length} of ${rawList.length} notices could not be read. Bulk is all-or-nothing.`,
        parsed: [],
        failed,
      });
      return;
    }

    res.json({ ok: true, charged: true, parsed, failed: [] });
  });

  return router;
}
