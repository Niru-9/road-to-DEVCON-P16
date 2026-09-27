/**
 * A facilitator that answers `/supported` and refuses to do anything else.
 *
 * Why this exists: the x402 resource server builds a 402 from the kinds the
 * facilitator advertises. Hand it a client with no `getSupported`, or skip the
 * handshake entirely, and an unpaid request comes back 500 instead of 402 —
 * which is exactly the bug this stub was written to pin down.
 *
 * With this stub the route tests get real 402s, with real requirements, and
 * make no network calls. `verify` and `settle` throw loudly: a hermetic test
 * that accidentally reached the payment path should fail, not pass quietly.
 */
import type { FacilitatorClient } from "@x402/core/server";

/** The only network the stub advertises, matching the server's own allowlist. */
export const TESTNET_NETWORK = "eip155:11155111";

/** Call counters, so a test can assert nothing was verified or settled. */
export type FacilitatorSpy = {
  getSupportedCalls: number;
  verifyCalls: number;
  settleCalls: number;
};

export function makeStubFacilitator(
  options: { network?: string } = {},
): { client: FacilitatorClient; spy: FacilitatorSpy } {
  const network = options.network ?? TESTNET_NETWORK;
  const spy: FacilitatorSpy = { getSupportedCalls: 0, verifyCalls: 0, settleCalls: 0 };

  const client = {
    async getSupported() {
      spy.getSupportedCalls += 1;
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network }],
        extensions: [],
        signers: {},
      };
    },

    async verify() {
      spy.verifyCalls += 1;
      throw new Error(
        "the stub facilitator must never be asked to verify — this suite does not pay",
      );
    },

    async settle() {
      spy.settleCalls += 1;
      throw new Error(
        "the stub facilitator must never be asked to settle — this suite does not pay",
      );
    },
  } as unknown as FacilitatorClient;

  return { client, spy };
}
