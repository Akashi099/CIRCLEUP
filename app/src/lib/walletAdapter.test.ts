/**
 * Issue #904: Freighter behind the WalletAdapter boundary.
 *
 * Covers absent provider, partial provider, account change, network mismatch
 * and user rejection, and checks that the app adapter plugs into the SDK's
 * `signWithWalletAdapter` unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const freighter = vi.hoisted(() => ({
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  signTransaction: vi.fn(),
  requestAccess: vi.fn(),
}));
vi.mock("@stellar/freighter-api", () => freighter);
vi.mock("./config", async () => {
  const fixtures = await import("../../../sdk/src/__tests__/fixtures");
  return {
    STELLAR_RPC_URL: fixtures.SDK_CONFIG.rpcUrl,
    NETWORK_PASSPHRASE: fixtures.SDK_CONFIG.networkPassphrase,
    CIRCLE_FACTORY_ADDRESS: fixtures.FACTORY_ADDR,
    REPUTATION_ADDRESS: fixtures.REPUTATION_ADDR,
    USDC_ADDRESS: fixtures.USDC_ADDR,
  };
});

import { signWithWalletAdapter } from "../../../sdk/src/walletAdapter";
import { freighterAdapter, type WalletAdapter } from "./walletAdapter";
import { submitContractTx } from "./stellar";
import { setDeploymentFacts } from "./deploymentState";
import { startTx } from "./telemetry";

const ACCOUNT = `G${"A".repeat(55)}`;
const OTHER = `G${"B".repeat(55)}`;
const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const fn = () => undefined;

function setProvider(provider: unknown) {
  (window as unknown as { freighter?: unknown }).freighter = provider;
}

beforeEach(() => {
  vi.clearAllMocks();
  freighter.isConnected.mockResolvedValue(true);
  freighter.getPublicKey.mockResolvedValue(ACCOUNT);
  setDeploymentFacts([{ name: "test evidence", status: "verified" }]);
});
afterEach(() => setProvider(undefined));

describe("freighterAdapter", () => {
  it("absent provider: reports nothing available and the SDK refuses before signing", async () => {
    setProvider(undefined);
    expect(freighterAdapter.capabilities().available).toBe(false);
    await expect(
      signWithWalletAdapter(freighterAdapter, "xdr", { networkPassphrase: TESTNET, accountToSign: ACCOUNT }),
    ).resolves.toMatchObject({ ok: false, reason: "not_available" });
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it("partial provider: reports exactly what the injected provider exposes", async () => {
    setProvider({ isConnected: fn, signTransaction: fn });
    expect(freighterAdapter.capabilities()).toEqual({
      available: true,
      supports: { getAddress: true, getNetwork: false, signTransaction: true, watchChanges: false },
    });
    await expect(freighterAdapter.getNetwork()).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_capability",
      capability: "getNetwork",
    });
  });

  it("network mismatch: discovered passphrase blocks SDK-assisted signing", async () => {
    setProvider({
      isConnected: fn,
      signTransaction: fn,
      getNetworkDetails: async () => ({ networkPassphrase: MAINNET }),
    });
    await expect(freighterAdapter.getNetwork()).resolves.toEqual({ ok: true, value: MAINNET });
    await expect(
      signWithWalletAdapter(freighterAdapter, "xdr", { networkPassphrase: TESTNET, accountToSign: ACCOUNT }),
    ).resolves.toMatchObject({ ok: false, reason: "network_mismatch" });
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it("account change: the SDK refuses to sign for a different active account", async () => {
    setProvider({ isConnected: fn, signTransaction: fn });
    freighter.getPublicKey.mockResolvedValue(OTHER);
    await expect(
      signWithWalletAdapter(freighterAdapter, "xdr", { networkPassphrase: TESTNET, accountToSign: ACCOUNT }),
    ).resolves.toMatchObject({ ok: false, reason: "account_mismatch" });
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it("user rejection is an explicit result, never a throw", async () => {
    setProvider({ isConnected: fn, signTransaction: fn });
    freighter.signTransaction.mockRejectedValue(new Error("User rejected the request"));
    await expect(
      freighterAdapter.signTransaction("xdr", { networkPassphrase: TESTNET, accountToSign: ACCOUNT }),
    ).resolves.toEqual({ ok: false, reason: "user_rejected", message: "User rejected the request" });
  });

  it("signs with the same Freighter call as before the adapter", async () => {
    setProvider({ isConnected: fn, signTransaction: fn });
    freighter.signTransaction.mockResolvedValue("signed-xdr");
    await expect(
      freighterAdapter.signTransaction("xdr", { networkPassphrase: TESTNET, accountToSign: ACCOUNT }),
    ).resolves.toEqual({ ok: true, value: "signed-xdr" });
    expect(freighter.signTransaction).toHaveBeenCalledWith("xdr", {
      networkPassphrase: TESTNET,
      accountToSign: ACCOUNT,
    });
  });
});

describe("submitContractTx with a non-Freighter adapter", () => {
  function adapter(overrides: Partial<WalletAdapter> & { canSign?: boolean } = {}): WalletAdapter {
    const { canSign = true, ...rest } = overrides;
    return {
      id: "test",
      capabilities: () => ({
        available: true,
        supports: { getAddress: true, getNetwork: false, signTransaction: canSign, watchChanges: false },
      }),
      getAddress: async () => ({ ok: true, value: ACCOUNT }),
      getNetwork: async () => ({ ok: false, reason: "unsupported_capability", message: "n/a" }),
      signTransaction: vi.fn(async () => ({ ok: false as const, reason: "user_rejected" as const, message: "User rejected" })),
      ...rest,
    };
  }

  it("fails an unsupported signing capability before any prompt", async () => {
    const wallet = adapter({ canSign: false });
    const result = await submitContractTx("prepared-xdr", ACCOUNT, startTx("join"), undefined, wallet);
    expect(result).toMatchObject({ success: false, txHash: "" });
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it("refuses to prompt when the adapter's account changed", async () => {
    const wallet = adapter({ getAddress: async () => ({ ok: true, value: OTHER }) });
    await expect(
      submitContractTx("prepared-xdr", ACCOUNT, startTx("join"), undefined, wallet),
    ).rejects.toThrow("Wallet account changed");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("maps an adapter's user rejection to the existing unsubmitted failure", async () => {
    const wallet = adapter();
    const result = await submitContractTx("prepared-xdr", ACCOUNT, startTx("contribute"), undefined, wallet);
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(result.success).toBe(false);
    expect(result.txHash).toBe("");
    expect(result.typedError).toBeDefined();
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });
});
