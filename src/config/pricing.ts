/**
 * The price table.
 *
 * This is the single source of truth for what a route costs. Prices are
 * integers in USDC base units and are handed to x402 as an explicit
 * `AssetAmount` - never as a dollar string.
 *
 * A dollar string would need the SDK's default-asset table to know which token
 * "a cent" means on a given chain, and it has no entry for Ethereum Sepolia:
 * `getDefaultAsset("eip155:11155111")` throws. So the wire price names the token
 * contract and the amount in base units directly, which needs no lookup and
 * cannot silently price a route in the wrong asset.
 *
 * Nothing in a request body, query string or header can reach this table.
 */
import { USDC_DECIMALS, USDC_SEPOLIA, EIP712_NAME, EIP712_VERSION } from "./env.js";
import { MAX_BULK_ITEMS } from "../domain/limits.js";

/** $0.0005 - five ten-thousandths of a cent. One notice. */
export const PRICE_SINGLE_BASE_UNITS = 500n;

/** $0.003 - a third of a cent for a whole batch. Cheaper per notice than single. */
export const PRICE_BULK_BASE_UNITS = 3_000n;

/**
 * An x402 v2 price requirement: the token, the amount in base units, and the
 * EIP-712 domain the payer must sign against.
 *
 * `amount` is a decimal string because it travels through JSON and a JS number
 * would lose precision above 2^53. The field is named `amount` in the v2 wire
 * format - v1 called it `maxAmountRequired`, and a consumer reading the old name
 * sees `undefined` against a v2 facilitator.
 */
export interface AssetAmount {
  readonly asset: string;
  readonly amount: string;
  readonly extra: { readonly name: string; readonly version: string };
}

/** The declared price of a route, for the x402 route config. */
export function assetAmountFor(baseUnits: bigint): AssetAmount {
  if (baseUnits < 0n) {
    throw new Error(`A price cannot be negative (got ${baseUnits} base units).`);
  }
  return {
    asset: USDC_SEPOLIA,
    amount: baseUnits.toString(),
    extra: { name: EIP712_NAME, version: EIP712_VERSION },
  };
}

/** Convenience for the UI and for the free price-preview route. */
export const PRICE_SINGLE_USD = 0.0005;
export const PRICE_BULK_USD = 0.003;

/**
 * Render base units as a human-readable price, e.g. 500n -> "$0.000500".
 *
 * For display only - the free `/v1/pricing` route, the 402 body, and the page.
 * The price x402 actually charges is `assetAmountFor`, which carries the token
 * and the base units rather than a dollar string. Uses BigInt division so there
 * is no binary floating point anywhere, including on the page.
 */
export function baseUnitsToPriceString(baseUnits: bigint, decimals = USDC_DECIMALS): `$${string}` {
  if (baseUnits < 0n) {
    throw new Error(`A price cannot be negative (got ${baseUnits} base units).`);
  }
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const fraction = (baseUnits % scale).toString().padStart(decimals, "0");
  return `$${whole}.${fraction}`;
}

/** Parse a price string such as "$0.0005" back into exact base units. */
export function priceStringToBaseUnits(price: string, decimals = USDC_DECIMALS): bigint {
  const match = /^\$?(\d+)(?:\.(\d+))?$/.exec(price.trim());
  if (!match || match[1] === undefined) {
    throw new Error(`Not a price string: ${price}`);
  }
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  return whole * 10n ** BigInt(decimals) + BigInt(fraction === "" ? "0" : fraction);
}

export type PricedRoute = {
  readonly route: string;
  /** Exact USDC base units, as a string — JSON has no integer type beyond double. */
  readonly baseUnits: string;
  readonly price: `$${string}`;
  readonly summary: string;
};

/**
 * Machine-readable price list, served by the free `/v1/pricing` route.
 *
 * Base units are serialised as decimal strings. `JSON.stringify` throws on a
 * BigInt, and a number would lose precision above 2^53 — neither is acceptable
 * for a price.
 */
export function priceList(network: string, payTo: string): {
  network: string;
  payTo: string;
  asset: "USDC";
  decimals: number;
  routes: PricedRoute[];
} {
  return {
    network,
    payTo,
    asset: "USDC",
    decimals: USDC_DECIMALS,
    routes: [
      {
        route: "POST /v1/parse",
        baseUnits: PRICE_SINGLE_BASE_UNITS.toString(),
        price: baseUnitsToPriceString(PRICE_SINGLE_BASE_UNITS),
        summary: "Parse one delay notice",
      },
      {
        route: "POST /v1/parse/bulk",
        baseUnits: PRICE_BULK_BASE_UNITS.toString(),
        price: baseUnitsToPriceString(PRICE_BULK_BASE_UNITS),
        summary: `Parse up to ${MAX_BULK_ITEMS} notices in one call`,
      },
    ],
  };
}
