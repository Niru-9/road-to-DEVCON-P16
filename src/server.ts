/**
 * Server entry point.
 *
 * Configuration is validated before the listener is bound. A misconfigured
 * price table or an unset recipient address is a startup failure, not a
 * runtime surprise on someone's first request.
 */
import { buildApp } from "./http/app.js";
import { loadConfig } from "./config/env.js";
import { priceList } from "./config/pricing.js";

function main(): void {
  const config = loadConfig();
  const app = buildApp({ config });

  const server = app.listen(config.port, () => {
    const prices = priceList(config.network, config.payTo);
    console.log("");
    console.log("  Meera's Railway Delay API");
    console.log(`  listening      http://localhost:${config.port}`);
    console.log(`  network        ${config.network}  (testnet)`);
    console.log(`  facilitator    ${config.facilitatorUrl}`);
    console.log(`  paid routes    ${prices.routes.map((r) => `${r.route} ${r.price}`).join("  |  ")}`);
    console.log(`  free routes    GET /v1/health  GET /v1/pricing  GET /v1/samples  POST /v1/validate`);
    console.log("");
  });

  const shutdown = (signal: string): void => {
    console.log(`\n  ${signal} received, closing.`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (error) {
  console.error(`\n  Startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
