/**
 * deploy-preflight.ts — Validate deployment configuration against selected contract network (Issue #895 / Issue 59)
 *
 * Requirements:
 * - Resolve selected network without silently substituting testnet defaults for production.
 * - Ensure contract IDs, RPC URL, network passphrase, token address, deployer key,
 *   and deployment manifest describe one coherent network.
 * - Validate contract address types (StrKey.isValidContract) and deployer key (StrKey.isValidEd25519PublicKey).
 * - Validate manifest consistency against expected network and contract IDs.
 * - Report which values are configured versus independently verified.
 * - Time-bounded (default 5000ms) live network RPC checks.
 * - Report unavailable remote checks separately from verified matches and mismatches.
 * - No fallback changes the requested network.
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { StrKey, rpc as StellarRpc } from "@stellar/stellar-sdk";

import { validateManifest, type DeploymentManifest } from "./deployment-manifest";
import {
  checkTokenAssumptions,
  type TokenAssumptionReport,
  type TokenCheckStatus,
} from "./check-token-assumptions";

// ── Types ─────────────────────────────────────────────────────────────────────

export type NetworkName = "testnet" | "mainnet" | "futurenet" | "standalone" | "custom";
export type RemoteCheckStatus = "verified" | "unavailable" | "mismatch" | "skipped";

export interface PreflightConfigInput {
  network?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  deployerPublicKey?: string;
  contractAddresses?: {
    circleFactory?: string;
    reputation?: string;
    usdc?: string;
    [key: string]: string | undefined;
  };
  manifestPath?: string;
  strict?: boolean;
  timeoutMs?: number;
  rpcClient?: {
    getNetwork: () => Promise<{ passphrase: string; protocolVersion?: number | string }>;
    simulateTransaction?: (tx: any) => Promise<any>;
  };
}

export interface ConfiguredFacts {
  resolvedNetwork: string;
  rpcUrl: string;
  networkPassphrase: string;
  deployerPublicKey?: string;
  contractAddresses: Record<string, string>;
  manifestPath?: string;
}

export interface VerifiedFacts {
  addressTypesValid: boolean;
  passphraseFormatValid: boolean;
  manifestConsistencyVerified: boolean;
  remoteRpcStatus: RemoteCheckStatus;
  remoteRpcPassphrase?: string;
  remoteRpcProtocolVersion?: number;
  remoteRpcError?: string;
  tokenStatus?: TokenCheckStatus;
}

export interface PreflightReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  configuredFacts: ConfiguredFacts;
  verifiedFacts: VerifiedFacts;
  tokenReport?: TokenAssumptionReport;
  summary: string;
}

// ── Canonical Constants ───────────────────────────────────────────────────────

export const CANONICAL_PASSPHRASES: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
};

export const CANONICAL_RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban.stellar.org",
};

const KNOWN_NETWORKS = ["testnet", "mainnet", "futurenet", "standalone"];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function resolveNetwork(inputNetwork?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (inputNetwork && inputNetwork.trim()) {
    return inputNetwork.trim();
  }
  if (env.NETWORK && env.NETWORK.trim()) {
    return env.NETWORK.trim();
  }
  if (env.CIRCLEUP_NETWORK && env.CIRCLEUP_NETWORK.trim()) {
    return env.CIRCLEUP_NETWORK.trim();
  }
  if (env.CIRCLEUP_PROFILE && env.CIRCLEUP_PROFILE.trim()) {
    const profile = env.CIRCLEUP_PROFILE.trim().toLowerCase();
    if (profile === "production") return "mainnet";
    if (profile === "staging" || profile === "testnet") return "testnet";
    return profile;
  }
  // Enforce no silent testnet default in production
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Network resolution error: No deployment network specified. " +
      "Silent testnet defaults are disabled in production. Set NETWORK explicitly."
    );
  }
  return "testnet";
}

/**
 * Execute a promise with a hard time limit.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationLabel: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operationLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

// ── Main Preflight Implementation ─────────────────────────────────────────────

export async function runDeployPreflight(
  input: PreflightConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<PreflightReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const timeoutMs = input.timeoutMs ?? 5000;
  const isStrict = input.strict ?? false;

  // 1. Resolve network
  let resolvedNetwork = "";
  try {
    resolvedNetwork = resolveNetwork(input.network, env);
  } catch (err: any) {
    errors.push(err.message);
    resolvedNetwork = "unresolved";
  }

  const isProduction =
    resolvedNetwork === "mainnet" ||
    env.NODE_ENV === "production" ||
    (env.CIRCLEUP_PROFILE && env.CIRCLEUP_PROFILE.toLowerCase() === "production");

  // 2. Resolve network passphrase
  let resolvedPassphrase = input.networkPassphrase ?? env.NETWORK_PASSPHRASE;
  if (!resolvedPassphrase) {
    if (isProduction && resolvedNetwork === "mainnet") {
      errors.push("NETWORK_PASSPHRASE is required for mainnet; testnet defaults are disabled.");
      resolvedPassphrase = "";
    } else if (CANONICAL_PASSPHRASES[resolvedNetwork]) {
      resolvedPassphrase = CANONICAL_PASSPHRASES[resolvedNetwork];
    } else {
      errors.push(`NETWORK_PASSPHRASE is missing and no canonical passphrase exists for "${resolvedNetwork}".`);
      resolvedPassphrase = "";
    }
  }

  // 3. Resolve RPC URL
  let resolvedRpcUrl = input.rpcUrl ?? env.STELLAR_RPC_URL ?? env.RPC_URL;
  if (!resolvedRpcUrl) {
    if (isProduction && resolvedNetwork === "mainnet") {
      errors.push("STELLAR_RPC_URL is required for mainnet; testnet defaults are disabled.");
      resolvedRpcUrl = "";
    } else if (CANONICAL_RPC_URLS[resolvedNetwork]) {
      resolvedRpcUrl = CANONICAL_RPC_URLS[resolvedNetwork];
    } else {
      errors.push(`STELLAR_RPC_URL is missing and no canonical RPC exists for "${resolvedNetwork}".`);
      resolvedRpcUrl = "";
    }
  }

  // 4. Coherent network cross-checks
  if (resolvedNetwork === "mainnet") {
    if (resolvedPassphrase && resolvedPassphrase === CANONICAL_PASSPHRASES.testnet) {
      errors.push("Passphrase mismatch: Target network is mainnet, but testnet passphrase was configured.");
    }
    if (resolvedRpcUrl && (resolvedRpcUrl.includes("testnet") || resolvedRpcUrl.includes("futurenet"))) {
      errors.push(`RPC URL mismatch: Target network is mainnet, but non-mainnet RPC (${resolvedRpcUrl}) was configured.`);
    }
  } else if (resolvedNetwork === "testnet") {
    if (resolvedPassphrase && resolvedPassphrase === CANONICAL_PASSPHRASES.mainnet) {
      errors.push("Passphrase mismatch: Target network is testnet, but mainnet passphrase was configured.");
    }
    if (resolvedRpcUrl && resolvedRpcUrl.includes("soroban.stellar.org") && !resolvedRpcUrl.includes("testnet")) {
      errors.push(`RPC URL mismatch: Target network is testnet, but mainnet RPC (${resolvedRpcUrl}) was configured.`);
    }
  }

  // 5. Validate address types
  let addressTypesValid = true;
  const deployerKey = input.deployerPublicKey ?? env.DEPLOYER_PUBLIC_KEY;
  if (deployerKey) {
    if (!StrKey.isValidEd25519PublicKey(deployerKey)) {
      errors.push(
        `Invalid deployer public key "${deployerKey}". Expected valid 56-character Ed25519 public key (G...).`
      );
      addressTypesValid = false;
    }
  }

  const contractAddresses: Record<string, string> = {};
  const rawContracts = {
    circleFactory: input.contractAddresses?.circleFactory ?? env.CIRCLE_FACTORY_ADDRESS,
    reputation: input.contractAddresses?.reputation ?? env.REPUTATION_ADDRESS,
    usdc: input.contractAddresses?.usdc ?? env.USDC_ADDRESS,
    ...(input.contractAddresses ?? {}),
  };

  for (const [name, addr] of Object.entries(rawContracts)) {
    if (addr && typeof addr === "string" && addr.trim() !== "") {
      contractAddresses[name] = addr.trim();
      if (!StrKey.isValidContract(addr.trim())) {
        errors.push(
          `Invalid contract address for ${name}: "${addr}". Expected valid 56-character contract ID (C...).`
        );
        addressTypesValid = false;
      }
    }
  }

  // 6. Manifest consistency verification
  let manifestConsistencyVerified = true;
  const manifestPath =
    input.manifestPath ??
    (fs.existsSync(path.join(__dirname, "../deployed-manifest.json"))
      ? path.join(__dirname, "../deployed-manifest.json")
      : undefined);

  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const manifestRaw = fs.readFileSync(manifestPath, "utf8");
      const manifest: DeploymentManifest = JSON.parse(manifestRaw);

      if (manifest.network !== resolvedNetwork) {
        errors.push(
          `Manifest network mismatch: manifest records network "${manifest.network}", but selected network is "${resolvedNetwork}".`
        );
        manifestConsistencyVerified = false;
      }

      if (manifest.networkPassphrase !== resolvedPassphrase) {
        errors.push(
          `Manifest passphrase mismatch: manifest records "${manifest.networkPassphrase}", but selected passphrase is "${resolvedPassphrase}".`
        );
        manifestConsistencyVerified = false;
      }

      const manifestValidation = validateManifest(manifestPath, resolvedNetwork);
      if (!manifestValidation.ok) {
        errors.push(`Manifest integrity check failed: ${manifestValidation.errors.join("; ")}`);
        manifestConsistencyVerified = false;
      }

      // Check contract address matching between config and manifest
      if (contractAddresses.usdc && manifest.contracts?.usdc && contractAddresses.usdc !== manifest.contracts.usdc) {
        errors.push(
          `USDC address mismatch: configured "${contractAddresses.usdc}", but manifest records "${manifest.contracts.usdc}".`
        );
        manifestConsistencyVerified = false;
      }
      if (
        contractAddresses.circleFactory &&
        manifest.contracts?.circleFactory?.contractId &&
        contractAddresses.circleFactory !== manifest.contracts.circleFactory.contractId
      ) {
        errors.push(
          `CircleFactory address mismatch: configured "${contractAddresses.circleFactory}", but manifest records "${manifest.contracts.circleFactory.contractId}".`
        );
        manifestConsistencyVerified = false;
      }
      if (
        contractAddresses.reputation &&
        manifest.contracts?.reputation?.contractId &&
        contractAddresses.reputation !== manifest.contracts.reputation.contractId
      ) {
        errors.push(
          `Reputation address mismatch: configured "${contractAddresses.reputation}", but manifest records "${manifest.contracts.reputation.contractId}".`
        );
        manifestConsistencyVerified = false;
      }
    } catch (err: any) {
      errors.push(`Failed to read/validate manifest at ${manifestPath}: ${err.message}`);
      manifestConsistencyVerified = false;
    }
  }

  // 7. Time-bounded live-network RPC check
  let remoteRpcStatus: RemoteCheckStatus = "skipped";
  let remoteRpcPassphrase: string | undefined;
  let remoteRpcProtocolVersion: number | undefined;
  let remoteRpcError: string | undefined;

  if (resolvedRpcUrl) {
    try {
      const rpcClient =
        input.rpcClient ??
        new StellarRpc.Server(resolvedRpcUrl, {
          allowHttp: resolvedRpcUrl.startsWith("http://"),
        });

      const networkDetails = await withTimeout(
        rpcClient.getNetwork(),
        timeoutMs,
        `RPC getNetwork (${resolvedRpcUrl})`
      );

      remoteRpcPassphrase = networkDetails.passphrase;
      remoteRpcProtocolVersion =
        networkDetails.protocolVersion !== undefined
          ? typeof networkDetails.protocolVersion === "number"
            ? networkDetails.protocolVersion
            : parseInt(String(networkDetails.protocolVersion), 10)
          : undefined;

      if (remoteRpcPassphrase === resolvedPassphrase) {
        remoteRpcStatus = "verified";
      } else {
        remoteRpcStatus = "mismatch";
        errors.push(
          `Remote RPC passphrase mismatch: Live RPC at ${resolvedRpcUrl} reported passphrase ` +
          `"${remoteRpcPassphrase}", but configuration expects "${resolvedPassphrase}".`
        );
      }
    } catch (err: any) {
      remoteRpcStatus = "unavailable";
      remoteRpcError = err.message ?? "Unknown RPC error";

      if (isStrict) {
        errors.push(
          `Strict preflight failed: Live RPC check to ${resolvedRpcUrl} was unavailable (${remoteRpcError}).`
        );
      } else {
        warnings.push(
          `Remote RPC check unavailable at ${resolvedRpcUrl} (${remoteRpcError}). ` +
          `Local configuration validated, but live on-chain connection could not be verified.`
        );
      }
    }
  }

  // 8. Executable USDC token assumption check (Issue #892)
  let tokenReport: TokenAssumptionReport | undefined;
  let tokenStatus: TokenCheckStatus | undefined;
  const usdcAddr = contractAddresses.usdc;

  if (usdcAddr) {
    tokenReport = await checkTokenAssumptions({
      tokenAddress: usdcAddr,
      network: resolvedNetwork,
      rpcUrl: resolvedRpcUrl,
      timeoutMs,
      rpcClient: input.rpcClient?.simulateTransaction ? { simulateTransaction: input.rpcClient.simulateTransaction } : undefined,
    });
    tokenStatus = tokenReport.status;

    if (tokenReport.status === "mismatch") {
      errors.push(...tokenReport.errors);
    } else if (tokenReport.status === "unavailable") {
      if (isStrict) {
        errors.push(`Strict preflight token check failed: ${tokenReport.summary}`);
      } else {
        warnings.push(`Token assumptions check unavailable: ${tokenReport.summary}`);
      }
    } else if (tokenReport.status === "unverifiable") {
      warnings.push(`Token assumptions unverifiable on-chain: ${tokenReport.summary}`);
    }
  }

  const ok = errors.length === 0;
  const summary = ok
    ? `Preflight passed for network "${resolvedNetwork}" (RPC: ${remoteRpcStatus}, token: ${
        tokenStatus ?? "unconfigured"
      }, manifest: ${manifestPath ? "verified" : "not present"}).`
    : `Preflight failed with ${errors.length} error(s) for network "${resolvedNetwork}".`;

  return {
    ok,
    errors,
    warnings,
    configuredFacts: {
      resolvedNetwork,
      rpcUrl: resolvedRpcUrl,
      networkPassphrase: resolvedPassphrase,
      deployerPublicKey: deployerKey,
      contractAddresses,
      manifestPath,
    },
    verifiedFacts: {
      addressTypesValid,
      passphraseFormatValid: resolvedPassphrase.length > 0,
      manifestConsistencyVerified,
      remoteRpcStatus,
      remoteRpcPassphrase,
      remoteRpcProtocolVersion,
      remoteRpcError,
      tokenStatus,
    },
    tokenReport,
    summary,
  };
}

// ── CLI Runner ────────────────────────────────────────────────────────────────

if (require.main === module) {
  dotenv.config({ path: path.join(__dirname, "../.env") });

  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const networkArg = getArg("--network");
  const rpcArg = getArg("--rpc");
  const passphraseArg = getArg("--passphrase");
  const manifestArg = getArg("--manifest");
  const strictArg = args.includes("--strict");
  const jsonArg = args.includes("--json");

  runDeployPreflight({
    network: networkArg,
    rpcUrl: rpcArg,
    networkPassphrase: passphraseArg,
    manifestPath: manifestArg,
    strict: strictArg,
  })
    .then((report) => {
      if (jsonArg) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log("\n========================================================");
        console.log("       CIRCLEUP DEPLOYMENT CONFIGURATION PREFLIGHT       ");
        console.log("========================================================\n");
        console.log(`[Target Network] : ${report.configuredFacts.resolvedNetwork}`);
        console.log(`[Configured RPC] : ${report.configuredFacts.rpcUrl}`);
        console.log(`[Passphrase]     : ${report.configuredFacts.networkPassphrase}`);
        if (report.configuredFacts.deployerPublicKey) {
          console.log(`[Deployer Key]   : ${report.configuredFacts.deployerPublicKey}`);
        }
        console.log(`[Remote RPC]     : ${report.verifiedFacts.remoteRpcStatus.toUpperCase()}`);
        if (report.verifiedFacts.remoteRpcError) {
          console.log(`  └ Reason       : ${report.verifiedFacts.remoteRpcError}`);
        }
        console.log(`[Addresses Valid]: ${report.verifiedFacts.addressTypesValid ? "YES" : "NO"}`);
        console.log(`[Token Status]   : ${(report.verifiedFacts.tokenStatus ?? "SKIPPED").toUpperCase()}`);
        console.log(`[Manifest Valid] : ${report.verifiedFacts.manifestConsistencyVerified ? "YES" : "NO"}`);
        console.log("\n--------------------------------------------------------");
        if (report.warnings.length > 0) {
          console.log("\nWARNINGS:");
          report.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
        }
        if (report.errors.length > 0) {
          console.log("\nERRORS:");
          report.errors.forEach((e) => console.log(`  ❌ ${e}`));
        }
        console.log("\nSUMMARY: " + report.summary + "\n");
      }
      process.exit(report.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("Fatal preflight error:", err);
      process.exit(1);
    });
}

