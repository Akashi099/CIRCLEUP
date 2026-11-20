/**
 * Issue #904: wallet provider adapter boundary.
 *
 * Covers absent provider, partial provider, account change, network
 * mismatch and user rejection — each must fail before the provider's
 * signing prompt with an explicit result — plus server-side import safety.
 */

import { describe, expect, it, vi } from "vitest";
import {
  requireWalletCapability,
  signWithWalletAdapter,
  walletFailure,
  type WalletAdapter,
  type WalletCapability,
} from "../walletAdapter";

const ACCOUNT = `G${"A".repeat(55)}`;
const OTHER = `G${"B".repeat(55)}`;
const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const OPTIONS = { networkPassphrase: TESTNET, accountToSign: ACCOUNT };

function fakeAdapter(overrides: {
  available?: boolean;
  missing?: WalletCapability[];
  address?: string;
  network?: string;
  sign?: WalletAdapter["signTransaction"];
} = {}): WalletAdapter & { signTransaction: ReturnType<typeof vi.fn> } {
  const missing = new Set(overrides.missing ?? []);
  const has = (c: WalletCapability) => (overrides.available ?? true) && !missing.has(c);
  return {
    id: "fake",
    capabilities: () => ({
      available: overrides.available ?? true,
      supports: {
        getAddress: has("getAddress"),
        getNetwork: has("getNetwork"),
        signTransaction: has("signTransaction"),
        watchChanges: has("watchChanges"),
      },
    }),
    getAddress: async () => ({ ok: true, value: overrides.address ?? ACCOUNT }),
    getNetwork: async () => ({ ok: true, value: overrides.network ?? TESTNET }),
    signTransaction: vi.fn(overrides.sign ?? (async (xdr: string) => ({ ok: true as const, value: `signed:${xdr}` }))),
  };
}

describe("signWithWalletAdapter", () => {
  it("signs with the prepared account and network when every check passes", async () => {
    const adapter = fakeAdapter();
    await expect(signWithWalletAdapter(adapter, "xdr", OPTIONS)).resolves.toEqual({
      ok: true,
      value: "signed:xdr",
    });
    expect(adapter.signTransaction).toHaveBeenCalledWith("xdr", OPTIONS);
  });

  it("absent provider → not_available, no prompt", async () => {
    const adapter = fakeAdapter({ available: false });
    await expect(signWithWalletAdapter(adapter, "xdr", OPTIONS)).resolves.toMatchObject({
      ok: false,
      reason: "not_available",
    });
    expect(adapter.signTransaction).not.toHaveBeenCalled();
  });

  it("partial provider without signing → unsupported_capability before signing", async () => {
    const adapter = fakeAdapter({ missing: ["signTransaction"] });
    await expect(signWithWalletAdapter(adapter, "xdr", OPTIONS)).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_capability",
      capability: "signTransaction",
    });
    expect(adapter.signTransaction).not.toHaveBeenCalled();
  });

  it("partial provider without network discovery signs by default, refuses when required", async () => {
    const lenient = fakeAdapter({ missing: ["getNetwork"] });
    await expect(signWithWalletAdapter(lenient, "xdr", OPTIONS)).resolves.toMatchObject({ ok: true });

    const strict = fakeAdapter({ missing: ["getNetwork"] });
    await expect(
      signWithWalletAdapter(strict, "xdr", { ...OPTIONS, networkCheck: "require" }),
    ).resolves.toMatchObject({ ok: false, reason: "unsupported_capability", capability: "getNetwork" });
    expect(strict.signTransaction).not.toHaveBeenCalled();
  });

  it("account change → account_mismatch, no prompt", async () => {
    const adapter = fakeAdapter({ address: OTHER });
    await expect(signWithWalletAdapter(adapter, "xdr", OPTIONS)).resolves.toMatchObject({
      ok: false,
      reason: "account_mismatch",
    });
    expect(adapter.signTransaction).not.toHaveBeenCalled();
  });

  it("network mismatch → network_mismatch, no prompt", async () => {
    const adapter = fakeAdapter({ network: MAINNET });
    await expect(signWithWalletAdapter(adapter, "xdr", OPTIONS)).resolves.toMatchObject({
      ok: false,
      reason: "network_mismatch",
    });
    expect(adapter.signTransaction).not.toHaveBeenCalled();
  });

  it("user rejection is passed through as an explicit result", async () => {
    const adapter = fakeAdapter({
      sign: async () => walletFailure("user_rejected", "You declined the request."),
    });
    await expect(signWithWalletAdapter(adapter, "xdr", OPTIONS)).resolves.toEqual({
      ok: false,
      reason: "user_rejected",
      message: "You declined the request.",
    });
  });

  it("a throwing or empty-handed provider becomes provider_error", async () => {
    const throwing = fakeAdapter({ sign: async () => { throw new Error("extension crashed"); } });
    await expect(signWithWalletAdapter(throwing, "xdr", OPTIONS)).resolves.toMatchObject({
      ok: false,
      reason: "provider_error",
    });
    const empty = fakeAdapter({ sign: async () => ({ ok: true, value: "" }) });
    await expect(signWithWalletAdapter(empty, "xdr", OPTIONS)).resolves.toMatchObject({
      ok: false,
      reason: "provider_error",
    });
  });
});

describe("requireWalletCapability", () => {
  it("names the missing capability", () => {
    const report = fakeAdapter({ missing: ["watchChanges"] }).capabilities();
    expect(requireWalletCapability(report, "watchChanges")).toMatchObject({
      reason: "unsupported_capability",
      capability: "watchChanges",
    });
    expect(requireWalletCapability(report, "signTransaction")).toBeNull();
  });
});

describe("server-side import safety", () => {
  it("loads and runs without any browser global", async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    const mod = await import("../index");
    expect(typeof mod.signWithWalletAdapter).toBe("function");
  });
});
