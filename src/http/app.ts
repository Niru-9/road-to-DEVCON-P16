/**
 * Express application assembly.
 *
 * Order matters and is asserted by a test:
 *
 *   1. x402 payment middleware  — only the two paid routes, matched by path
 *   2. free routes              — health, pricing, samples, free validate
 *   3. paid route handlers      — mounted after the middleware
 *   4. 404 / error handler
 *
 * `x402HTTPResourceServer.requiresPayment` consults the route config, and
 * `paymentMiddleware` calls `next()` when a path is not in it. A global mount
 * therefore leaves the free routes alone, and there is no skip list to keep in
 * sync with the price table.
 */
import express, { type Express } from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FacilitatorClient } from "@x402/core/server";
import type { ServerConfig } from "../config/env.js";
import { buildPaymentLayer, ROUTE_BULK, ROUTE_SINGLE, type PaymentLayer } from "../payment/x402.js";
import { buildFreeRouter } from "./free-routes.js";
import { buildPaidRouter } from "./paid-routes.js";
import { recordCancellation, recordSettlement } from "./audit.js";
import { MAX_BODY_BYTES } from "../domain/limits.js";

export type AppOptions = {
  config: ServerConfig;
  /**
   * Replace the facilitator client. Tests pass a stub so the suite never
   * touches the network; production omits it and gets the real HTTP client.
   *
   * This cannot simply be a "skip the handshake" boolean. The resource server
   * derives the 402 from the facilitator's advertised kinds, so a skipped
   * handshake means an unpaid request gets a 500 instead of a 402.
   */
  facilitatorClient?: FacilitatorClient;
};

export type Services = {
  app: Express;
  /** Exposed so tests can inspect the declared payment requirements. */
  payment: PaymentLayer;
};

export function buildServices({ config, facilitatorClient }: AppOptions): Services {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    express.json({
      limit: MAX_BODY_BYTES,
      // Reject a body that is not JSON with a 4xx rather than a 500.
      type: ["application/json", "text/json"],
    }),
  );

  const payment = buildPaymentLayer(
    config,
    (event) => recordCancellation(event),
    (event) => recordSettlement(event),
    facilitatorClient,
  );

  // Step 1 — the payment middleware. It calls next() for any path that is not
  // in the route config, so the free routes below are never payment-gated.
  app.use(payment.middleware);

  // Steps 2 and 3.
  app.use(buildFreeRouter(config));
  app.use(buildPaidRouter());

  // The demo frontend. Static, no build step, no client-side framework.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const publicDir = resolve(here, "..", "..", "public");
  app.use(express.static(publicDir, { extensions: ["html"] }));

  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: "no-such-route",
      detail: `${req.method} ${req.path} is not part of this API.`,
      paidRoutes: [ROUTE_SINGLE, ROUTE_BULK],
    });
  });

  return { app, payment };
}

export function buildApp(options: AppOptions): Express {
  return buildServices(options).app;
}

export const PUBLIC_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "public",
);
