import { describe, it, expect } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import {
  checkTokenAssumptions,
  CANONICAL_MAINNET_USDC_ADDRESS,
  EXPECTED_USDC_DECIMALS,
  EXPECTED_USDC_SYMBOL,
} from "./check-token-assumptions";

const VALID_TESTNET_USDC = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const INVALID_CONTRACT_ID = "NOT_A_VALID_CONTRACT_STRING";

describe("checkTokenAssumptions", () => {
  it("rejects invalid contract ID address shape", async () => {
    const report = await checkTokenAssumptions({
      tokenAddress: INVALID_CONTRACT_ID,
      network: "testnet",
    });
    expect(report.status).toBe("mismatch");
    expect(report.onChainVerified.addressShapeValid).toBe(false);
    expect(report.errors.some((e) => e.includes("not a valid Stellar contract ID"))).toBe(true);
  });

  it("detects mainnet canonical SAC address mismatch", async () => {
    const report = await checkTokenAssumptions({
      tokenAddress: VALID_TESTNET_USDC,
      network: "mainnet",
    });
    expect(report.status).toBe("mismatch");
    expect(report.onChainVerified.addressShapeValid).toBe(true);
    expect(report.onChainVerified.isCanonicalMainnetAddress).toBe(false);
    expect(report.errors.some((e) => e.includes("canonical Mainnet USDC SAC address"))).toBe(true);
  });

  it("reports unverifiable when address shape is valid but live RPC is omitted", async () => {
    const report = await checkTokenAssumptions({
      tokenAddress: VALID_TESTNET_USDC,
      network: "testnet",
    });
    expect(report.status).toBe("unverifiable");
    expect(report.onChainVerified.addressShapeValid).toBe(true);
    expect(report.unverifiableNotes.some((n) => n.includes("Live RPC endpoint not provided"))).toBe(true);
  });

  it("passes on valid token with 7 decimals and USDC symbol", async () => {
    const mockRpc = {
      simulateTransaction: async (tx: any) => {
        const isSymbol = JSON.stringify(tx).includes("symbol");
        return {
          result: {
            retval: isSymbol ? nativeToScVal(EXPECTED_USDC_SYMBOL) : nativeToScVal(EXPECTED_USDC_DECIMALS),
          },
        };
      },
    };

    const report = await checkTokenAssumptions({
      tokenAddress: VALID_TESTNET_USDC,
      network: "testnet",
      rpcClient: mockRpc,
    });

    expect(report.status).toBe("pass");
    expect(report.onChainVerified.decimalsVerified).toBe(true);
    expect(report.onChainVerified.observedDecimals).toBe(7);
    expect(report.onChainVerified.symbolVerified).toBe(true);
    expect(report.errors.length).toBe(0);
  });

  it("mainnet passes on canonical address with verified decimals", async () => {
    const mockRpc = {
      simulateTransaction: async (tx: any) => {
        const isSymbol = JSON.stringify(tx).includes("symbol");
        return {
          result: {
            retval: isSymbol ? nativeToScVal("USDC") : nativeToScVal(7),
          },
        };
      },
    };

    const report = await checkTokenAssumptions({
      tokenAddress: CANONICAL_MAINNET_USDC_ADDRESS,
      network: "mainnet",
      rpcClient: mockRpc,
    });

    expect(report.status).toBe("pass");
    expect(report.onChainVerified.isCanonicalMainnetAddress).toBe(true);
    expect(report.onChainVerified.decimalsVerified).toBe(true);
  });

  it("flags mismatch when token decimals is not 7 (e.g. 6 or 18)", async () => {
    const mockRpc = {
      simulateTransaction: async () => ({
        result: {
          retval: nativeToScVal(6), // e.g. Ethereum USDC decimals
        },
      }),
    };

    const report = await checkTokenAssumptions({
      tokenAddress: VALID_TESTNET_USDC,
      network: "testnet",
      rpcClient: mockRpc,
    });

    expect(report.status).toBe("mismatch");
    expect(report.onChainVerified.observedDecimals).toBe(6);
    expect(report.onChainVerified.decimalsVerified).toBe(false);
    expect(report.errors.some((e) => e.includes("expected 7, got 6"))).toBe(true);
  });

  it("reports unavailable when RPC call throws / times out", async () => {
    const mockRpc = {
      simulateTransaction: async () => {
        throw new Error("Connection refused: 127.0.0.1:8000");
      },
    };

    const report = await checkTokenAssumptions({
      tokenAddress: VALID_TESTNET_USDC,
      network: "testnet",
      rpcClient: mockRpc,
    });

    expect(report.status).toBe("unavailable");
    expect(report.errors.some((e) => e.includes("Connection refused"))).toBe(true);
  });

  it("reports unverifiable when contract simulation fails to return retval", async () => {
    const mockRpc = {
      simulateTransaction: async () => ({
        error: "HostError: Error(Contract, #100)",
        result: undefined,
      }),
    };

    const report = await checkTokenAssumptions({
      tokenAddress: VALID_TESTNET_USDC,
      network: "testnet",
      rpcClient: mockRpc,
    });

    expect(report.status).toBe("unverifiable");
    expect(report.onChainVerified.contractExists).toBe(false);
  });
});
