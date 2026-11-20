import { test } from "node:test";
import assert from "node:assert/strict";
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

test("resolveNetwork: resolves explicit network argument first", () => {
  const net = resolveNetwork("futurenet", { NETWORK: "testnet" } as any);
  assert.equal(net, "futurenet");
});

test("resolveNetwork: enforces no silent fallback to testnet in production", () => {
  assert.throws(
    () => resolveNetwork(undefined, { NODE_ENV: "production" } as any),
    /Silent testnet defaults are disabled in production/
  );
});

test("missing values: rejects when production mainnet configuration lacks passphrase or RPC", async () => {
  const report = await runDeployPreflight(
    {
      network: "mainnet",
      // omitting rpcUrl and networkPassphrase
      rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.mainnet }) },
    },
    { NODE_ENV: "production" } as any
  );

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes("NETWORK_PASSPHRASE is required for mainnet")));
  assert.ok(report.errors.some((e) => e.includes("STELLAR_RPC_URL is required for mainnet")));
});

test("malformed addresses: rejects invalid contract ID and deployer key", async () => {
  const report = await runDeployPreflight({
    network: "testnet",
    deployerPublicKey: "G_INVALID_ACCOUNT_KEY",
    contractAddresses: {
      circleFactory: "C_MALFORMED_CONTRACT_ID",
      reputation: VALID_CONTRACT_1,
    },
    rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.testnet }) },
  });

  assert.equal(report.ok, false);
  assert.equal(report.verifiedFacts.addressTypesValid, false);
  assert.ok(report.errors.some((e) => e.includes("Invalid deployer public key")));
  assert.ok(report.errors.some((e) => e.includes("Invalid contract address for circleFactory")));
});

test("passphrase mismatch: rejects testnet passphrase when network is mainnet", async () => {
  const report = await runDeployPreflight({
    network: "mainnet",
    rpcUrl: "https://soroban.stellar.org",
    networkPassphrase: CANONICAL_PASSPHRASES.testnet, // WRONG!
    rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.mainnet }) },
  });

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes("Passphrase mismatch")));
});

test("passphrase mismatch: detects live RPC network mismatch", async () => {
  const report = await runDeployPreflight({
    network: "testnet",
    networkPassphrase: CANONICAL_PASSPHRASES.testnet,
    rpcUrl: CANONICAL_RPC_URLS.testnet,
    rpcClient: {
      getNetwork: async () => ({ passphrase: "Different Network Passphrase ; 2026" }),
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.verifiedFacts.remoteRpcStatus, "mismatch");
  assert.ok(report.errors.some((e) => e.includes("Remote RPC passphrase mismatch")));
});

test("RPC outage: reported separately as unavailable without altering requested network", async () => {
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
  assert.equal(report.ok, true);
  assert.equal(report.configuredFacts.resolvedNetwork, "testnet"); // requested network preserved
  assert.equal(report.verifiedFacts.remoteRpcStatus, "unavailable");
  assert.ok(report.verifiedFacts.remoteRpcError?.includes("ECONNREFUSED"));
  assert.ok(report.warnings.some((w) => w.includes("Remote RPC check unavailable")));
});

test("RPC outage: strict mode rejects when live check is unavailable", async () => {
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

  assert.equal(report.ok, false);
  assert.equal(report.verifiedFacts.remoteRpcStatus, "unavailable");
  assert.ok(report.errors.some((e) => e.includes("Strict preflight failed: Live RPC check")));
});

test("fully consistent profile: passes all validations and verifies remote RPC", async () => {
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

  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.configuredFacts.resolvedNetwork, "testnet");
  assert.equal(report.verifiedFacts.addressTypesValid, true);
  assert.equal(report.verifiedFacts.remoteRpcStatus, "verified");
  assert.equal(report.verifiedFacts.remoteRpcProtocolVersion, 21);
});
