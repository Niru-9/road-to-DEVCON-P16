/**
 * Buyer script — pays for a real request to a running Meera server.
 *
 * This is the client half of x402: it receives a 402, builds a signed payment
 * payload for Ethereum Sepolia, retries, and reports what it got back.
 *
 * ## This is NOT the intended payment path
 *
 * It signs with a key from `EVM_PRIVATE_KEY`, which makes it a *local
 * throwaway-key* tool for proving a payment end to end from a terminal. The
 * intended payer is a **browser wallet (MetaMask)**: this repository does not
 * ship a browser payment client yet, so the page in `public/` shows the real
 * 402 instead of pretending to pay. See "Limitations" in README.md.
 *
 * No key is bundled, required, or written to disk. The key is read from the
 * environment and never logged. Use a test-only key holding test USDC.
 *
 * Usage:
 *   npm run buy -- --sample en-structured-pune
 *   npm run buy -- --route bulk --sample en-structured-pune --sample mr-devanagari-digits
 *   npm run buy -- --text "TRAIN 12137 ... "
 *
 * Flags:
 *   --base-url <url>   default http://localhost:4021
 *   --route <single|bulk>  default single
 *   --sample <id>      repeatable; loads the notice text from the free route
 *   --text <string>    repeatable; literal notice text
 */
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

/** The only network this buyer will sign for, mirroring the server's allowlist. */
const ETHEREUM_SEPOLIA = "eip155:11155111";

type Args = {
  baseUrl: string;
  route: "single" | "bulk";
  samples: string[];
  texts: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: "http://localhost:4021",
    route: "single",
    samples: [],
    texts: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--base-url" && value !== undefined) {
      args.baseUrl = value;
      i += 1;
    } else if (flag === "--route" && value !== undefined) {
      if (value !== "single" && value !== "bulk") {
        throw new Error(`--route must be "single" or "bulk", got "${value}"`);
      }
      args.route = value;
      i += 1;
    } else if (flag === "--sample" && value !== undefined) {
      args.samples.push(value);
      i += 1;
    } else if (flag === "--text" && value !== undefined) {
      args.texts.push(value);
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument near "${flag ?? "(end)"}"`);
    }
  }
  return args;
}

function readPrivateKey(): `0x${string}` {
  const raw = process.env.EVM_PRIVATE_KEY?.trim();
  if (raw === undefined || raw === "") {
    throw new Error(
      "EVM_PRIVATE_KEY is not set. Put a TESTNET key in .env — never a key that holds real funds.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("EVM_PRIVATE_KEY must be 0x followed by 64 hex characters.");
  }
  return raw as `0x${string}`;
}

/** Pull notice text from the free samples route, so the buyer can stay short. */
async function resolveNotices(args: Args): Promise<string[]> {
  if (args.texts.length > 0) return args.texts;
  if (args.samples.length === 0) {
    throw new Error("Pass at least one --sample <id> or --text <notice>.");
  }
  const notices: string[] = [];
  for (const id of args.samples) {
    const response = await fetch(`${args.baseUrl}/v1/samples/${encodeURIComponent(id)}`);
    if (!response.ok) {
      throw new Error(`No sample with id "${id}" (${response.status}).`);
    }
    const body = (await response.json()) as { sample?: { text?: string } };
    const text = body.sample?.text;
    if (text === undefined) throw new Error(`Sample "${id}" carried no text.`);
    notices.push(text);
  }
  return notices;
}

type PricedRoute = { route: string; price: string; summary: string };

function showPriceList(baseUrl: string): void {
  console.log("\n  Server price list (server-defined; a client cannot change these):");
  void fetch(`${baseUrl}/v1/pricing`)
    .then((response) => response.json() as Promise<unknown>)
    .then((body: unknown) => {
      const routes = (body as { routes?: PricedRoute[] }).routes ?? [];
      for (const route of routes) {
        console.log(`    ${route.price.padStart(10)}  ${route.route.padEnd(22)} ${route.summary}`);
      }
    })
    .catch(() => undefined);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const privateKey = readPrivateKey();
  const account = privateKeyToAccount(privateKey);

  console.log(`\n  payer        ${account.address}`);
  console.log(`  base url     ${args.baseUrl}`);
  showPriceList(args.baseUrl);

  const notices = await resolveNotices(args);
  const path = args.route === "bulk" ? "/v1/parse/bulk" : "/v1/parse";
  const body =
    args.route === "bulk" ? JSON.stringify({ notices }) : JSON.stringify({ notice: notices[0] });

  const client = new x402Client();
  // Restricted to Ethereum Sepolia, mirroring the server's own allowlist.
  registerExactEvmScheme(client, { signer: account, networks: [ETHEREUM_SEPOLIA] });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const url = `${args.baseUrl}${path}`;
  console.log(`\n  POST ${url}`);
  console.log(`  notices      ${notices.length}`);
  console.log("  paying…");

  const response = await fetchWithPayment(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const settlement = response.headers.get("payment-response");
  console.log(`\n  HTTP ${response.status}`);
  if (settlement !== null) {
    console.log(`  payment-response  ${settlement.slice(0, 200)}`);
  } else {
    console.log("  payment-response  (none — nothing was settled)");
  }

  const payload = (await response.json()) as unknown;
  console.log(`\n${JSON.stringify(payload, null, 2)}`);

  if (response.status === 422) {
    console.log(
      "\n  422 means the notice was unreadable. The verified payment was released — nothing was charged.\n",
    );
  } else if (response.ok) {
    console.log("\n  200 means the notice was parsed and the payment settled.\n");
  }
}

main().catch((error: unknown) => {
  console.error(`\n  Buyer failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
