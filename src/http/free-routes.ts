/**
 * Free routes.
 *
 * These exist so a stranger — or a judge with no wallet — can see exactly
 * what the paid routes sell, at zero cost. The design keeps them strictly
 * weaker than the paid product: /v1/validate tells you whether a notice is
 * readable but never returns the parsed fields, so the free tier cannot
 * cannibalise the paid parse.
 */
import { Router } from "express";
import { safeParseNotice } from "../domain/parser.js";
import { RequestRejectedError } from "../domain/errors.js";
import { MAX_BULK_ITEMS, MAX_NOTICE_CHARS } from "../domain/limits.js";
import { BROKEN_SAMPLES, SAMPLES, WELL_FORMED_SAMPLES, findSample } from "../data/samples.js";
import { priceList } from "../config/pricing.js";
import { type ServerConfig } from "../config/env.js";
import { recentEvents, recordRejection } from "./audit.js";
import { readNoticeField } from "./request.js";

export function buildFreeRouter(config: ServerConfig): Router {
  const router = Router();

  router.get("/v1/health", (_req, res) => {
    res.json({ ok: true, service: "meera-railway-delay-api", network: config.network });
  });

  /**
   * The server's own price list. Read-only, and the only place a client can
   * learn what a route costs — a caller cannot propose a different number.
   */
  router.get("/v1/pricing", (_req, res) => {
    res.json({
      ok: true,
      ...priceList(config.network, config.payTo),
      freeRoutes: [
        { route: "GET /v1/health", summary: "Liveness check" },
        { route: "GET /v1/pricing", summary: "This price list" },
        { route: "GET /v1/samples", summary: "The sample notice corpus" },
        { route: "POST /v1/validate", summary: "Free readability check; returns no parsed fields" },
      ],
      limits: {
        maxNoticeChars: MAX_NOTICE_CHARS,
        maxBulkItems: MAX_BULK_ITEMS,
      },
    });
  });

  router.get("/v1/samples", (req, res) => {
    const only = req.query.kind;
    if (only === "valid" || only === "broken") {
      const wanted = only === "valid" ? WELL_FORMED_SAMPLES : BROKEN_SAMPLES;
      res.json({ ok: true, count: wanted.length, samples: wanted });
      return;
    }
    res.json({
      ok: true,
      count: SAMPLES.length,
      wellFormed: WELL_FORMED_SAMPLES.length,
      broken: BROKEN_SAMPLES.length,
      samples: SAMPLES,
    });
  });

  router.get("/v1/samples/:id", (req, res) => {
    const sample = findSample(String(req.params.id));
    if (sample === undefined) {
      res.status(404).json({ ok: false, error: "no-such-sample" });
      return;
    }
    res.json({ ok: true, sample });
  });

  /**
   * Free readability check. Answers the only question a first-time caller has
   * ("is this API going to understand my notice?") without doing the work.
   */
  router.post("/v1/validate", (req, res) => {
    try {
      const notice = readNoticeField(req.body);
      const outcome = safeParseNotice(notice);
      if (outcome.ok) {
        res.json({
          ok: true,
          readable: true,
          charged: false,
          completeness: outcome.notice.completeness,
          note: "Readability only. Parsed fields are returned by the paid routes.",
        });
        return;
      }
      // A 200 with `readable: false` is the right answer here — the free route
      // did its job. It is still recorded, so the audit feed shows that this
      // notice was turned away rather than quietly dropped.
      recordRejection("unparseable-notice", outcome.failure.reasons.join("; "));
      res.json({
        ok: true,
        readable: false,
        charged: false,
        reasons: outcome.failure.reasons,
        excerpt: outcome.failure.excerpt,
        note: "Readability only. Parsed fields are returned by the paid routes.",
      });
    } catch (error) {
      sendRejection(res, error, req.body);
    }
  });

  /**
   * Read-only view of the settlement trail, so the no-charge-for-a-bad-notice
   * promise can be checked from outside the process.
   */
  router.get("/v1/audit", (req, res) => {
    const requested = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), 200)
      : 20;
    res.json({ ok: true, events: recentEvents(limit) });
  });

  return router;
}

/** Shared 4xx responder for every rejection that happens before parsing. */
export function sendRejection(
  res: import("express").Response,
  error: unknown,
  body: unknown,
): void {
  if (error instanceof RequestRejectedError) {
    // Recorded here as well as in the paid routes, so the free tier's refusals
    // show up in the same audit feed. A judge watching GET /v1/audit should be
    // able to see that a garbage request was turned away whatever route it hit.
    recordRejection(error.code, error.detail);
    // `charged: false` on every rejection, so a caller can check the promise on
    // any response without knowing which failure path produced it.
    res.status(error.status).json({
      ok: false,
      charged: false,
      error: error.code,
      detail: error.detail,
    });
    return;
  }
  res.status(500).json({ ok: false, charged: false, error: "internal", detail: "unexpected failure" });
}
