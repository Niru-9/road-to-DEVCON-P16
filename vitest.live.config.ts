import { defineConfig } from "vitest/config";

/**
 * The live testnet suite.
 *
 * Separate from vitest.config.ts because it needs EVM_PRIVATE_KEY and
 * X402_PAY_TO, reaches the public x402 facilitator, and spends real (testnet)
 * USDC. It is never part of `npm test`.
 */
export default defineConfig({
  test: {
    include: ["tests/live.test.ts"],
    environment: "node",
    // A 402 round trip plus settlement is slow. Generous on purpose.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
