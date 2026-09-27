import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The live suite needs real testnet credentials and real funds. It is
    // excluded from the default run and opted into with `npm run test:live`.
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live.test.ts", "node_modules/**"],
    environment: "node",
    testTimeout: 15_000,
  },
});

