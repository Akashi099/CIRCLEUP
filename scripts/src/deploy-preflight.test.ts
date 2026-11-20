import { describe, it, expect } from "vitest";
import {
  runDeployPreflight,
  resolveNetwork,
  CANONICAL_PASSPHRASES,
  CANONICAL_RPC_URLS,
} from "./deploy-preflight";

// Valid testnet addresses for testing
const VALID_CONTRACT_1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_CONTRACT_2 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const VALID_DEPLOYER   = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("deployPreflight", () => {
  it("resolveNetwork: resolves explicit network argument first", () => {
    const net = resolveNetwork("futurenet", { NETWORK: "testnet" } as any);
    expect(net).toBe("futurenet");
  });

  it("resolveNetwork: enforces no silent fallback to testnet in production", () => {
    expect(() => resolveNetwork(undefined, { NODE_ENV: "production" } as any)).toThrow(
      /Silent testnet defaults are disabled in production/
    );
  });

  it("missing values: rejects when production mainnet configuration lacks passphrase or RPC", async () => {
    const report = await runDeployPreflight(
      {
        network: "mainnet",
        // omitting rpcUrl and networkPassphrase
        rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.mainnet }) },
      },
      { NODE_ENV: "production" } as any
    );

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("NETWORK_PASSPHRASE is required for mainnet"))).toBe(true);
    expect(report.errors.some((e) => e.includes("STELLAR_RPC_URL is required for mainnet"))).toBe(true);
  });

  it("malformed addresses: rejects invalid contract ID and deployer key", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      deployerPublicKey: "G_INVALID_ACCOUNT_KEY",
      contractAddresses: {
        circleFactory: "C_MALFORMED_CONTRACT_ID",
        reputation: VALID_CONTRACT_1,
      },
      rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.testnet }) },
    });

    expect(report.ok).toBe(false);
    expect(report.verifiedFacts.addressTypesValid).toBe(false);
    expect(report.errors.some((e) => e.includes("Invalid deployer public key"))).toBe(true);
    expect(report.errors.some((e) => e.includes("Invalid contract address for circleFactory"))).toBe(true);
  });

  it("passphrase mismatch: rejects testnet passphrase when network is mainnet", async () => {
    const report = await runDeployPreflight({
      network: "mainnet",
      rpcUrl: "https://soroban.stellar.org",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet, // WRONG!
      rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.mainnet }) },
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("Passphrase mismatch"))).toBe(true);
  });

  it("passphrase mismatch: detects live RPC network mismatch", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet,
      rpcUrl: CANONICAL_RPC_URLS.testnet,
      rpcClient: {
        getNetwork: async () => ({ passphrase: "Different Network Passphrase ; 2026" }),
      },
    });

    expect(report.ok).toBe(false);
    expect(report.verifiedFacts.remoteRpcStatus).toBe("mismatch");
    expect(report.errors.some((e) => e.includes("Remote RPC passphrase mismatch"))).toBe(true);
  });

  it("RPC outage: reported separately as unavailable without altering requested network", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet,
      rpcUrl: CANONICAL_RPC_URLS.testnet,
      strict: false,
      rpcClient: {
        getNetwork: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
        },
      },
    });

    // Non-strict: local config is valid, outage reported separately as unavailable
    expect(report.ok).toBe(true);
    expect(report.configuredFacts.resolvedNetwork).toBe("testnet"); // requested network preserved
    expect(report.verifiedFacts.remoteRpcStatus).toBe("unavailable");
    expect(report.verifiedFacts.remoteRpcError?.includes("ECONNREFUSED")).toBe(true);
    expect(report.warnings.some((w) => w.includes("Remote RPC check unavailable"))).toBe(true);
  });

  it("RPC outage: strict mode rejects when live check is unavailable", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet,
      rpcUrl: CANONICAL_RPC_URLS.testnet,
      strict: true,
      rpcClient: {
        getNetwork: async () => {
          throw new Error("Network timeout after 5000ms");
        },
      },
    });

    expect(report.ok).toBe(false);
    expect(report.verifiedFacts.remoteRpcStatus).toBe("unavailable");
    expect(report.errors.some((e) => e.includes("Strict preflight failed: Live RPC check"))).toBe(true);
  });

  it("fully consistent profile: passes all validations and verifies remote RPC", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet,
      rpcUrl: CANONICAL_RPC_URLS.testnet,
      deployerPublicKey: VALID_DEPLOYER,
      contractAddresses: {
        reputation: VALID_CONTRACT_1,
        circleFactory: VALID_CONTRACT_2,
      },
      rpcClient: {
        getNetwork: async () => ({
          passphrase: CANONICAL_PASSPHRASES.testnet,
          protocolVersion: 21,
        }),
      },
    });

    expect(report.ok).toBe(true);
    expect(report.errors.length).toBe(0);
    expect(report.configuredFacts.resolvedNetwork).toBe("testnet");
    expect(report.verifiedFacts.addressTypesValid).toBe(true);
    expect(report.verifiedFacts.remoteRpcStatus).toBe("verified");
    expect(report.verifiedFacts.remoteRpcProtocolVersion).toBe(21);
  });

  it("validates token assumptions when USDC address is configured", async () => {
    const report = await runDeployPreflight({
      network: "mainnet",
      networkPassphrase: CANONICAL_PASSPHRASES.mainnet,
      rpcUrl: "https://soroban.stellar.org",
      contractAddresses: {
        usdc: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM", // Not canonical mainnet
      },
      rpcClient: {
        getNetwork: async () => ({
          passphrase: CANONICAL_PASSPHRASES.mainnet,
          protocolVersion: 21,
        }),
      },
    });

    expect(report.ok).toBe(false);
    expect(report.verifiedFacts.tokenStatus).toBe("mismatch");
    expect(report.errors.some((e) => e.includes("canonical Mainnet USDC SAC address"))).toBe(true);
  });
});
