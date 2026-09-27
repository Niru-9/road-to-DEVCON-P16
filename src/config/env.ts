/**
 * Server-side configuration.
 *
 * Nothing here is derived from a request. The price table, the recipient, the
 * network and the facilitator URL are all resolved once, at startup, from
 * constants and the environment — a caller cannot influence any of them.
 */
import { z } from "zod";

/** USDC has 6 decimals on every chain here. All money is counted in base units. */
export const USDC_DECIMALS = 6;

/**
 * The one network this server speaks.
 *
 * Ethereum Sepolia. Chosen deliberately over a Base testnet: the facilitator
 * this project points at advertises `exact` on `eip155:11155111`, and a chain
 * the facilitator does not serve cannot produce a 402 at all.
 */
export const ETHEREUM_SEPOLIA = "eip155:11155111";

/** Circle-issued USDC on Ethereum Sepolia. */
export const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

/**
 * The EIP-712 domain the token itself reports on chain.
 *
 * `name()` and `version()` were read from the contract, not guessed. The payer
 * signs `TransferWithAuthorization` against exactly these values, so a mismatch
 * here produces a signature the facilitator will reject.
 */
export const EIP712_NAME = "USDC";
export const EIP712_VERSION = "2";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4021),
  X402_FACILITATOR_URL: z
    .string()
    .url()
    .default("https://facilitator.x402.rs"),
  X402_PAY_TO: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "X402_PAY_TO must be a 0x-prefixed EVM address"),
  X402_NETWORK: z.string().default(ETHEREUM_SEPOLIA),
});

/**
 * Networks this server is allowed to use. The build refuses to start on a
 * network that is not on this list, so a mainnet identifier cannot be
 * introduced through configuration by accident.
 *
 * Ethereum Sepolia only. Both Base mainnet (`eip155:8453`) and Base Sepolia
 * (`eip155:84532`) are deliberately absent.
 */
export const ALLOWED_NETWORKS = [ETHEREUM_SEPOLIA] as const;
export type AllowedNetwork = (typeof ALLOWED_NETWORKS)[number];

export type ServerConfig = {
  readonly port: number;
  readonly facilitatorUrl: string;
  readonly payTo: string;
  readonly network: AllowedNetwork;
};

let cached: ServerConfig | null = null;

/**
 * Read and validate configuration. Throws with an actionable message rather
 * than starting a server that would silently accept payments wrongly.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid configuration — ${detail}. Copy .env.example to .env and fill it in.`,
    );
  }

  const network = parsed.data.X402_NETWORK as AllowedNetwork;
  if (!ALLOWED_NETWORKS.includes(network)) {
    throw new Error(
      `Refusing to start: X402_NETWORK=${network} is not a permitted testnet. ` +
        `Allowed: ${ALLOWED_NETWORKS.join(", ")}. This server is testnet-only by design.`,
    );
  }

  cached = {
    port: parsed.data.PORT,
    facilitatorUrl: parsed.data.X402_FACILITATOR_URL,
    payTo: parsed.data.X402_PAY_TO,
    network,
  };
  return cached;
}

/** Config for tests, which pass an explicit environment instead of mutating process.env. */
export function configForTesting(source: Partial<NodeJS.ProcessEnv>): ServerConfig {
  return loadConfig({
    X402_PAY_TO: "0x1111111111111111111111111111111111111111",
    ...source,
  } as NodeJS.ProcessEnv);
}

export function getConfig(): ServerConfig {
  if (cached === null) return loadConfig();
  return cached;
}
