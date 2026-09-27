/**
 * x402 wiring.
 *
 * The important decision in this file is what is NOT here:
 * `extra: { paymentFlow: "upfront" }`.
 *
 * The `exact` scheme defaults to the `authorization` flow — the facilitator
 * verifies the payment, then the route handler runs, and only a successful
 * handler leads to settlement. When the handler returns an error response,
 * x402 raises `onVerifiedPaymentCanceled` with reason `handler_failed` and
 * the payment is never settled. That is the mechanism behind Meera's rule:
 * an unreadable notice costs the caller nothing.
 *
 * Switching to `upfront` would settle before the handler and break that
 * promise, so the route config below is asserted against it in the tests.
 */
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import type { NextFunction, Request, Response } from "express";
import type { ServerConfig } from "../config/env.js";
import { USDC_DECIMALS } from "../config/env.js";
import { assetAmountFor, baseUnitsToPriceString, PRICE_BULK_BASE_UNITS, PRICE_SINGLE_BASE_UNITS } from "../config/pricing.js";

export const ROUTE_SINGLE = "POST /v1/parse";
export const ROUTE_BULK = "POST /v1/parse/bulk";

/**
 * The declared payment requirements.
 *
 * `price` and `payTo` are server-owned. They are not functions of the
 * request; there is no code path from a body field or query parameter to
 * either value.
 */
export function buildRoutesConfig(config: ServerConfig): RoutesConfig {
  return {
    [ROUTE_SINGLE]: {
      accepts: [
        {
          scheme: "exact",
          price: assetAmountFor(PRICE_SINGLE_BASE_UNITS),
          network: config.network,
          payTo: config.payTo,
        },
      ],
      description:
        "Parse one Indian Railways delay notice into validated JSON. Unreadable notices are not charged.",
      mimeType: "application/json",
      serviceName: "meera-railway-delay-api",
      tags: ["railways", "india", "delay-notice", "parser"],
      // A 402 with an empty body is a bad first impression. Say what happened,
      // what it costs, and what a caller can try for free.
      unpaidResponseBody: () => unpaidBody("POST /v1/parse", PRICE_SINGLE_BASE_UNITS),
    },
    [ROUTE_BULK]: {
      accepts: [
        {
          scheme: "exact",
          price: assetAmountFor(PRICE_BULK_BASE_UNITS),
          network: config.network,
          payTo: config.payTo,
        },
      ],
      description:
        "Parse up to 25 delay notices in one call, at a lower per-notice price than the single route.",
      mimeType: "application/json",
      serviceName: "meera-railway-delay-api",
      tags: ["railways", "india", "delay-notice", "parser", "bulk"],
      unpaidResponseBody: () => unpaidBody("POST /v1/parse/bulk", PRICE_BULK_BASE_UNITS),
    },
  };
}

/** The body of a 402, written for a human reading a JSON error. */
function unpaidBody(route: string, baseUnits: bigint) {
  return {
    contentType: "application/json",
    body: {
      ok: false,
      error: "payment-required",
      charged: false,
      detail: `${route} is a paid route. Attach an x402 payment to the retry; the requirements are in the Payment-Required header.`,
      price: {
        amount: baseUnits.toString(),
        display: baseUnitsToPriceString(baseUnits),
        asset: "USDC",
        decimals: USDC_DECIMALS,
        note: "The price is set by this server and cannot be changed by the request.",
      },
      freeAlternatives: ["GET /v1/samples", "POST /v1/validate"],
    },
  };
}

export function buildResourceServer(
  config: ServerConfig,
  facilitatorClient: FacilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
): x402ResourceServer {
  return new x402ResourceServer(facilitatorClient).register(
    config.network,
    new ExactEvmScheme(),
  );
}

export type PaymentLayer = {
  /**
   * A plain Express handler. `paymentMiddleware` returns
   * `(req, res, next) => Promise<void>`, and it calls `next()` for any path
   * that is not in the route config — so mounting it at the app root is safe
   * and the free routes need no skip list.
   */
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  resourceServer: x402ResourceServer;
  routesConfig: RoutesConfig;
};

export function buildPaymentLayer(
  config: ServerConfig,
  onVerifiedPaymentCanceled: (event: {
    reason: string;
    responseStatus?: number;
  }) => void,
  onSettled: (event: { amount: string; payer: string; transaction: string }) => void,
  /**
   * Swap the facilitator. Tests pass a stub; production uses the real one.
   *
   * This is not an optimisation — it is a correctness requirement. The resource
   * server builds a 402 from the facilitator's advertised `kinds`, so without
   * a successful `initialize()` it cannot even quote a price: an unpaid request
   * comes back 500 ("Facilitator does not support exact on eip155:11155111")
   * instead of 402. See ARCHITECTURE.md.
   */
  facilitatorClient?: FacilitatorClient,
): PaymentLayer {
  const routesConfig = buildRoutesConfig(config);
  const resourceServer = buildResourceServer(config, facilitatorClient);

  // A verified payment that never settles is the mechanism that refunds the
  // caller on an unreadable notice. Logged so the behaviour is auditable.
  resourceServer.onVerifiedPaymentCanceled(async (context) => {
    onVerifiedPaymentCanceled({
      reason: context.reason,
      ...(context.responseStatus === undefined ? {} : { responseStatus: context.responseStatus }),
    });
  });

  resourceServer.onAfterSettle(async (context) => {
    // `upfront` settles in the "before-handler" phase. This server runs the
    // default authorization flow, so only "after-handler" is a real charge.
    if (context.phase !== "after-handler") return;
    onSettled({
      amount: context.requirements.amount,
      payer: context.result.payer ?? "unknown",
      transaction: context.result.transaction,
    });
  });

  const middleware = paymentMiddleware(
    routesConfig,
    resourceServer,
    undefined,
    undefined,
    // Always true. A 402 cannot be produced without the facilitator's
    // supported kinds, and skipping the handshake turns a 402 into a 500.
    true,
  );

  return { middleware, resourceServer, routesConfig };
}
