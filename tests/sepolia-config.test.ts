/**
 * Ethereum Sepolia configuration, and the x402 v2 402 it must produce.
 *
 * ## What this pins
 *
 * The project moved from a Base testnet to Ethereum Sepolia
 * (`eip155:11155111`). Two things about that move are easy to get quietly
 * wrong, and both are asserted here rather than assumed:
 *
 * 1. **The network is the only one.** `ALLOWED_NETWORKS` is a single entry, and
 *    `loadConfig` still throws for anything else - including the Base networks
 *    the project used before, so a stale `.env` fails loudly instead of
 *    silently reverting the migration.
 *
 * 2. **The price is an explicit `AssetAmount`, not a dollar string.** The SDK
 *    has no default asset for Ethereum Sepolia - `getDefaultAsset` *throws* for
 *    `eip155:11155111` - so a `"$0.0005"` price cannot resolve to a token. The
 *    route config must therefore name the asset and the integer base units, and
 *    the EIP-712 domain the payer signs against.
 *
 * The decoded 402 is read off the wire from a real request, so these assert what
 * a client would actually receive, not what the config was written to say.
 */
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildServices } from "../src/http/app.js";
import { makeStubFacilitator, TESTNET_NETWORK } from "./stub-facilitator.js";
import {
  ALLOWED_NETWORKS,
  EIP712_NAME,
  EIP712_VERSION,
  ETHEREUM_SEPOLIA,
  USDC_DECIMALS,
  USDC_SEPOLIA,
  configForTesting,
  loadConfig,
} from "../src/config/env.js";
import {
  PRICE_BULK_BASE_UNITS,
  PRICE_SINGLE_BASE_UNITS,
  assetAmountFor,
} from "../src/config/pricing.js";
import { buildRoutesConfig } from "../src/payment/x402.js";
import { resetAudit } from "../src/http/audit.js";

const PAY_TO = "0x3333333333333333333333333333333333333333";
const READABLE_NOTICE =
  "TRAIN 12137 DEEPAK EXPRESS, STATION PUNE JN, EXPECTED DEPARTURE 19:30";

function makeApp() {
  const { client } = makeStubFacilitator();
  return buildServices({ config: configForTesting({ X402_PAY_TO: PAY_TO }), facilitatorClient: client });
}

type Requirements = {
  x402Version: number;
  accepts: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    extra: Record<string, unknown>;
  }[];
};

/** Read the v2 payment requirements off the wire, the way a client does. */
async function readRequirements(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; reqs: Requirements }> {
  const { app } = makeApp();
  const response = await request(app).post(path).send(body);
  const header = response.headers["payment-required"];
  if (typeof header !== "string") throw new Error(`expected a Payment-Required header, got ${response.status}`);
  return {
    status: response.status,
    reqs: JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Requirements,
  };
}

beforeEach(() => {
  resetAudit();
});

describe("Ethereum Sepolia is the only configured network", () => {
  it("allowlists exactly eip155:11155111", () => {
    expect(ETHEREUM_SEPOLIA).toBe("eip155:11155111");
    expect(ALLOWED_NETWORKS).toEqual(["eip155:11155111"]);
    // The networks this project used before the migration must be gone, so a
    // stale value cannot quietly bring the old chain back.
    expect(ALLOWED_NETWORKS).not.toContain("eip155:84532");
    expect(ALLOWED_NETWORKS).not.toContain("eip155:8453");
    expect(ALLOWED_NETWORKS).not.toContain("eip155:1");
  });

  it("defaults to Sepolia and refuses every other network", () => {
    expect(configForTesting({}).network).toBe("eip155:11155111");
    for (const rejected of ["eip155:84532", "eip155:8453", "eip155:1", "eip155:11155112"]) {
      expect(() => loadConfig({ X402_PAY_TO: PAY_TO, X402_NETWORK: rejected } as NodeJS.ProcessEnv)).toThrow(
        /not a permitted testnet/,
      );
    }
  });

  it("defaults the facilitator to the one that serves Sepolia", () => {
    expect(configForTesting({}).facilitatorUrl).toBe("https://facilitator.x402.rs");
  });

  it("the test stub advertises the same network the server quotes", () => {
    // If these drift, every 402 in the suite would be quoting a chain no
    // facilitator serves, and the tests would still pass on the stub.
    expect(TESTNET_NETWORK).toBe(ETHEREUM_SEPOLIA);
  });
});

describe("the token is Circle's Ethereum Sepolia USDC", () => {
  it("uses the documented address, decimals and EIP-712 domain", () => {
    expect(USDC_SEPOLIA).toBe("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
    expect(USDC_DECIMALS).toBe(6);
    // Read from the contract: name() = "USDC", version() = "2".
    expect(EIP712_NAME).toBe("USDC");
    expect(EIP712_VERSION).toBe("2");
  });

  it("builds an AssetAmount carrying the asset, the integer amount and the domain", () => {
    const amount = assetAmountFor(500n);
    expect(amount).toEqual({
      asset: USDC_SEPOLIA,
      amount: "500",
      extra: { name: "USDC", version: "2" },
    });
  });

  it("emits integer base units, never a number or a dollar string", () => {
    for (const units of [PRICE_SINGLE_BASE_UNITS, PRICE_BULK_BASE_UNITS, 1n, 999_999n]) {
      const amount = assetAmountFor(units);
      expect(typeof amount.amount).toBe("string");
      expect(amount.amount).toMatch(/^\d+$/);
      expect(BigInt(amount.amount)).toBe(units);
    }
    expect(() => assetAmountFor(-1n)).toThrow(/cannot be negative/);
  });

  it("keeps the prices the project already charged", () => {
    // 500 and 3000 base units at 6 decimals: $0.0005 and $0.003. The migration
    // changed the chain, not the price.
    expect(PRICE_SINGLE_BASE_UNITS).toBe(500n);
    expect(PRICE_BULK_BASE_UNITS).toBe(3_000n);
    expect(assetAmountFor(PRICE_SINGLE_BASE_UNITS).amount).toBe("500");
    expect(assetAmountFor(PRICE_BULK_BASE_UNITS).amount).toBe("3000");
  });
});

describe("the 402 a client receives on the wire", () => {
  it("is x402 v2, exact, on Sepolia, in Sepolia USDC", async () => {
    const { status, reqs } = await readRequirements("/v1/parse", { notice: READABLE_NOTICE });

    expect(status).toBe(402);
    expect(reqs.x402Version).toBe(2);

    const accepts = reqs.accepts[0]!;
    expect(accepts.scheme).toBe("exact");
    expect(accepts.network).toBe("eip155:11155111");
    expect(accepts.asset.toLowerCase()).toBe(USDC_SEPOLIA.toLowerCase());
    expect(accepts.amount).toBe("500");
    expect(accepts.payTo).toBe(PAY_TO);
    // The domain the payer must sign, carried in the requirement itself.
    expect(accepts.extra).toMatchObject({ name: "USDC", version: "2" });
  });

  it("uses the v2 `amount` field, not v1's `maxAmountRequired`", async () => {
    const { reqs } = await readRequirements("/v1/parse", { notice: READABLE_NOTICE });
    const raw = reqs.accepts[0]! as unknown as Record<string, unknown>;
    // v1 called this `maxAmountRequired`. A consumer still reading the old name
    // gets `undefined` against a v2 facilitator and would price the call wrong.
    expect(raw["amount"]).toBe("500");
    expect(raw["maxAmountRequired"]).toBeUndefined();
  });

  it("quotes the bulk price on the bulk route", async () => {
    const { status, reqs } = await readRequirements("/v1/parse/bulk", { notices: [READABLE_NOTICE] });
    expect(status).toBe(402);
    expect(reqs.accepts[0]!.amount).toBe("3000");
    expect(reqs.accepts[0]!.asset.toLowerCase()).toBe(USDC_SEPOLIA.toLowerCase());
  });

  it("quotes a server-owned price the request cannot move", async () => {
    // A caller offering its own price, payee and network changes nothing.
    const { reqs } = await readRequirements("/v1/parse", {
      notice: READABLE_NOTICE,
      price: "$0.00",
      amount: "1",
      payTo: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      network: "eip155:84532",
    });
    const accepts = reqs.accepts[0]!;
    expect(accepts.amount).toBe("500");
    expect(accepts.payTo).toBe(PAY_TO);
    expect(accepts.network).toBe("eip155:11155111");
  });

  it("declares the same requirements in the static route config", async () => {
    // The wire and the declared config must not be able to disagree.
    const routes = buildRoutesConfig(configForTesting({ X402_PAY_TO: PAY_TO }));
    for (const route of Object.values(routes)) {
      const accepts = Array.isArray(route.accepts) ? route.accepts : [route.accepts];
      for (const option of accepts) {
        expect(option.network).toBe("eip155:11155111");
        expect(option.payTo).toBe(PAY_TO);
        const price = option.price as { asset: string; amount: string; extra: { name: string; version: string } };
        expect(price.asset).toBe(USDC_SEPOLIA);
        expect(price.extra).toEqual({ name: "USDC", version: "2" });
      }
    }
  });
});
