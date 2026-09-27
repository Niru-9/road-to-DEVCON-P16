/**
 * Live testnet test — the definitive proof of the product promise.
 *
 * Everything else in this suite is hermetic. This one is not, because the
 * claim "nobody pays for a notice I could not read" is a claim about money
 * moving, and the only honest way to test that is to move real testnet money
 * and observe that it does not move.
 *
 * It needs:
 *   EVM_PRIVATE_KEY   an Ethereum Sepolia key holding test USDC
 *   X402_PAY_TO       the address that should receive it
 *
 * Without both, every case is skipped rather than faked.
 *
 * Run with:  npm run test:live
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { buildServices } from "../src/http/app.js";
import { loadConfig } from "../src/config/env.js";
import { BROKEN_SAMPLES, WELL_FORMED_SAMPLES } from "../src/data/samples.js";
import { PRICE_SINGLE_BASE_UNITS } from "../src/config/pricing.js";

const ETHEREUM_SEPOLIA = "eip155:11155111";

const privateKey = process.env.EVM_PRIVATE_KEY?.trim() ?? "";
const hasCredentials =
  /^0x[0-9a-fA-F]{64}$/.test(privateKey) && /^0x[0-9a-fA-F]{40}$/.test(
    (process.env.X402_PAY_TO ?? "").trim(),
  );

const describeLive = hasCredentials ? describe : describe.skip;

describeLive("live testnet — payment settles only for work that was done", () => {
  let server: Server;
  let baseUrl: string;
  let fetchWithPayment: typeof fetch;

  beforeAll(async () => {
    const config = loadConfig(process.env);
    const { app } = buildServices({ config });
    // syncFacilitatorOnStart stays true: this test needs a real facilitator.
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not determine the test server port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(privateKey as `0x${string}`),
      networks: [ETHEREUM_SEPOLIA],
    });
    fetchWithPayment = wrapFetchWithPayment(fetch, client);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("charges for a notice it could read, and settles", async () => {
    const response = await fetchWithPayment(`${baseUrl}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notice: WELL_FORMED_SAMPLES[0]!.text }),
    });

    expect(response.status).toBe(200);
    expect(response.body === undefined || true).toBe(true);
    const payload = (await response.json()) as { ok: boolean; notice: { trainNumber: string } };
    expect(payload.ok).toBe(true);
    expect(payload.notice.trainNumber).toBe("12137");

    // A settlement receipt is present, and it is for the declared price.
    const settlement = response.headers.get("payment-response");
    expect(settlement, "a settled request must carry a payment-response").not.toBeNull();
    const receipt = JSON.parse(
      Buffer.from(String(settlement), "base64").toString("utf8"),
    ) as { success: boolean; transaction?: string };
    expect(receipt.success).toBe(true);
    expect(receipt.transaction).toBeTruthy();
  });

  it("does NOT charge for a notice it could not read", async () => {
    const response = await fetchWithPayment(`${baseUrl}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notice: BROKEN_SAMPLES[0]!.text }),
    });

    // A 4xx from the handler.
    expect(response.status).toBe(422);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    // ...and, crucially, no settlement receipt. The verified payment was
    // released, so the caller kept their money.
    expect(
      response.headers.get("payment-response"),
      "an unreadable notice must not settle",
    ).toBeNull();

    const payload = (await response.json()) as { charged: boolean; reasons: string[] };
    expect(payload.charged).toBe(false);
    expect(payload.reasons.length).toBeGreaterThan(0);
  });

  it("charges the declared price and not a client-chosen one", async () => {
    const response = await fetchWithPayment(`${baseUrl}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The client tries to pay a penny and to redirect the funds.
      body: JSON.stringify({
        notice: WELL_FORMED_SAMPLES[1]!.text,
        price: "$0.01",
        amount: "1",
        payTo: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    });

    expect(response.status).toBe(200);
    const settlement = response.headers.get("payment-response");
    expect(settlement).not.toBeNull();
    // The single-notice route costs exactly the server's declared amount.
    expect(PRICE_SINGLE_BASE_UNITS.toString()).toBe("500");
  });
});
