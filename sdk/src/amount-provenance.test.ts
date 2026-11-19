/**
 * amount-provenance.test.ts — Tests for monetary amount unit labels and export formatting
 * Issue #855: Add on-chain and indexed data provenance to exported amounts
 *
 * Verifies that every exported amount carries unambiguous unit labels (stroops, USDC,
 * or exact USDC) so that decimal strings cannot be mistaken for raw token integers.
 * Tests cover:
 *   - Zero values across all unit types
 *   - Fractional amounts (2 dp display vs. 7 dp exact)
 *   - Very large amounts (near i128 max)
 *   - Maximum precision values (7 decimal places)
 *   - TaggedAmount round-tripping (stroops → display → stroops)
 *   - API and CSV export scenarios
 */

import { describe, it, expect } from "vitest";
import {
  UNIT_STROOPS,
  UNIT_USDC,
  UNIT_USDC_EXACT,
  TaggedAmount,
  tagStroops,
  toDisplayUsdc,
  toExactUsdc,
  formatUsdc,
  stroopsToUsdc,
  usdcToStroops,
} from "./utils";

describe("Amount Provenance: Unit Labels", () => {
  describe("UNIT_STROOPS constant", () => {
    it("has correct value", () => {
      expect(UNIT_STROOPS).toBe("stroops");
    });
  });

  describe("UNIT_USDC constant", () => {
    it("has correct value", () => {
      expect(UNIT_USDC).toBe("USDC");
    });
  });

  describe("UNIT_USDC_EXACT constant", () => {
    it("has correct value", () => {
      expect(UNIT_USDC_EXACT).toBe("USDC (exact)");
    });
  });
});

describe("tagStroops: Tag raw stroop integers", () => {
  it("tags a valid stroop integer string", () => {
    const result = tagStroops("100000000");
    expect(result).toEqual({
      amount: "100000000",
      unit: UNIT_STROOPS,
    });
  });

  it("tags zero", () => {
    const result = tagStroops("0");
    expect(result).toEqual({
      amount: "0",
      unit: UNIT_STROOPS,
    });
  });

  it("tags very large stroop values", () => {
    // Near i128 max: 9223372036854775807
    const result = tagStroops("9223372036854775807");
    expect(result).toEqual({
      amount: "9223372036854775807",
      unit: UNIT_STROOPS,
    });
  });

  it("trims whitespace before validation", () => {
    const result = tagStroops("  42  ");
    expect(result).toEqual({
      amount: "42",
      unit: UNIT_STROOPS,
    });
  });

  it("throws on non-integer stroop string", () => {
    expect(() => tagStroops("100.5")).toThrow(
      /expected a decimal integer string/i,
    );
  });

  it("throws on USDC display string (catches common mistake)", () => {
    expect(() => tagStroops("1.5")).toThrow(/did you pass a usdc/i);
  });

  it("throws on negative stroops", () => {
    expect(() => tagStroops("-1000")).toThrow(/decimal integer/i);
  });

  it("throws on non-numeric input", () => {
    expect(() => tagStroops("abc")).toThrow(/decimal integer/i);
  });

  it("throws on empty string", () => {
    expect(() => tagStroops("")).toThrow(/decimal integer/i);
  });
});

describe("toDisplayUsdc: Convert stroops to 2-decimal display with unit", () => {
  it("converts 100,000,000 stroops to '10.00 USDC'", () => {
    const result = toDisplayUsdc(100_000_000n);
    expect(result).toEqual({
      amount: "10.00",
      unit: UNIT_USDC,
    });
  });

  it("converts 15,000,000 stroops to '1.50 USDC'", () => {
    const result = toDisplayUsdc(15_000_000n);
    expect(result).toEqual({
      amount: "1.50",
      unit: UNIT_USDC,
    });
  });

  it("converts 100,000 stroops to '0.01 USDC'", () => {
    const result = toDisplayUsdc(100_000n);
    expect(result).toEqual({
      amount: "0.01",
      unit: UNIT_USDC,
    });
  });

  it("converts 1 stroop to '0.00 USDC' (truncates)", () => {
    const result = toDisplayUsdc(1n);
    expect(result).toEqual({
      amount: "0.00",
      unit: UNIT_USDC,
    });
  });

  it("converts zero stroops to '0.00 USDC'", () => {
    const result = toDisplayUsdc(0n);
    expect(result).toEqual({
      amount: "0.00",
      unit: UNIT_USDC,
    });
  });

  it("accepts string input (from indexer API)", () => {
    const result = toDisplayUsdc("100000000");
    expect(result).toEqual({
      amount: "10.00",
      unit: UNIT_USDC,
    });
  });

  it("accepts number input", () => {
    const result = toDisplayUsdc(100_000_000);
    expect(result).toEqual({
      amount: "10.00",
      unit: UNIT_USDC,
    });
  });

  it("returns '0.00 USDC' for invalid input", () => {
    const result = toDisplayUsdc("invalid");
    expect(result).toEqual({
      amount: "0.00",
      unit: UNIT_USDC,
    });
  });

  it("returns '0.00 USDC' for negative stroops", () => {
    const result = toDisplayUsdc(-100_000_000n);
    expect(result).toEqual({
      amount: "0.00",
      unit: UNIT_USDC,
    });
  });

  it("truncates (does not round) fractional display", () => {
    // 12,349,999 stroops = 1.2349999 USDC, displays as 1.23 (truncated, not 1.24)
    const result = toDisplayUsdc(12_349_999n);
    expect(result).toEqual({
      amount: "1.23",
      unit: UNIT_USDC,
    });
  });

  it("handles very large amounts", () => {
    // 922,337,203,685,477 stroops = 92,233.72 USDC
    const result = toDisplayUsdc(922_337_203_685_477n);
    expect(result).toEqual({
      amount: "92233.72",
      unit: UNIT_USDC,
    });
  });
});

describe("toExactUsdc: Convert stroops to 7-decimal exact value with unit", () => {
  it("converts 100,000,000 stroops to '10.0000000 USDC (exact)'", () => {
    const result = toExactUsdc(100_000_000n);
    expect(result).toEqual({
      amount: "10.0000000",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("converts 15,000,000 stroops to '1.5000000 USDC (exact)'", () => {
    const result = toExactUsdc(15_000_000n);
    expect(result).toEqual({
      amount: "1.5000000",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("converts 1 stroop to '0.0000001 USDC (exact)'", () => {
    const result = toExactUsdc(1n);
    expect(result).toEqual({
      amount: "0.0000001",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("converts zero stroops to '0.0000000 USDC (exact)'", () => {
    const result = toExactUsdc(0n);
    expect(result).toEqual({
      amount: "0.0000000",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("preserves full 7-decimal precision (no rounding)", () => {
    // 12,345,678 stroops = 1.2345678 USDC (exact, full precision)
    const result = toExactUsdc(12_345_678n);
    expect(result).toEqual({
      amount: "1.2345678",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("accepts string input (from indexer API)", () => {
    const result = toExactUsdc("100000000");
    expect(result).toEqual({
      amount: "10.0000000",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("accepts number input", () => {
    const result = toExactUsdc(100_000_000);
    expect(result).toEqual({
      amount: "10.0000000",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("returns '0.0000000 USDC (exact)' for invalid input", () => {
    const result = toExactUsdc("invalid");
    expect(result).toEqual({
      amount: "0.0000000",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("returns '0.0000000 USDC (exact)' for negative stroops", () => {
    const result = toExactUsdc(-100_000_000n);
    expect(result).toEqual({
      amount: "0.0000000",
      unit: UNIT_USDC_EXACT,
    });
  });

  it("preserves maximum precision (all 7 decimals)", () => {
    // 9,999,999 stroops = 0.9999999 USDC (just under 1 USDC)
    const result = toExactUsdc(9_999_999n);
    expect(result).toEqual({
      amount: "0.9999999",
      unit: UNIT_USDC_EXACT,
    });
  });
});

describe("Round-trip conversion: TaggedAmount → stroops → TaggedAmount", () => {
  it("round-trips 100,000,000 stroops", () => {
    const original = 100_000_000n;
    const tagged = toExactUsdc(original);
    // Extract amount string and convert back
    const stroopsBack = usdcToStroops(tagged.amount);
    expect(stroopsBack).toBe(original);
  });

  it("round-trips 1 stroop", () => {
    const original = 1n;
    const tagged = toExactUsdc(original);
    const stroopsBack = usdcToStroops(tagged.amount);
    expect(stroopsBack).toBe(original);
  });

  it("round-trips fractional amounts (0.1234567 USDC)", () => {
    const original = 1_234_567n; // 0.1234567 USDC
    const tagged = toExactUsdc(original);
    expect(tagged.amount).toBe("0.1234567");
    const stroopsBack = usdcToStroops(tagged.amount);
    expect(stroopsBack).toBe(original);
  });

  it("display conversion is lossy but documented", () => {
    const original = 100_001n; // 0.0100001 USDC
    const display = toDisplayUsdc(original);
    expect(display.amount).toBe("0.01"); // Truncated to 2 dp
    // Note: cannot round-trip from display because precision is lost
    expect(usdcToStroops(display.amount)).toBe(100_000n); // Not original
  });
});

describe("API and export scenarios", () => {
  it("API wire format: stroops with unit label", () => {
    const wireAmount: TaggedAmount = tagStroops("100000000");
    expect(`amount: ${wireAmount.amount} (${wireAmount.unit})`).toBe(
      "amount: 100000000 (stroops)",
    );
  });

  it("UI card format: 2-decimal display with unit", () => {
    const displayAmount = toDisplayUsdc(100_000_000n);
    expect(`balance: ${displayAmount.amount} ${displayAmount.unit}`).toBe(
      "balance: 10.00 USDC",
    );
  });

  it("CSV export format: exact 7-decimal with unit", () => {
    const exactAmount = toExactUsdc(100_000_000n);
    expect(`${exactAmount.amount},${exactAmount.unit}`).toBe(
      "10.0000000,USDC (exact)",
    );
  });

  it("SDK response: tagged amount prevents accidental unit confusion", () => {
    const response = {
      roundAmount: toExactUsdc(100_000_000n),
      memberCount: 4,
      totalPot: toDisplayUsdc(400_000_000n),
    };

    expect(response.roundAmount.unit).toBe(UNIT_USDC_EXACT);
    expect(response.totalPot.unit).toBe(UNIT_USDC);
    // Caller cannot accidentally treat stroops as USDC
    expect(response.roundAmount.amount).not.toEqual(
      response.totalPot.amount,
    );
  });
});

describe("Edge cases and maximum values", () => {
  it("handles i128 maximum value (9223372036854775807 stroops)", () => {
    const maxI128 = 9223372036854775807n;
    const exact = toExactUsdc(maxI128);
    expect(exact.unit).toBe(UNIT_USDC_EXACT);
    // 922337203685477.5807 USDC
    expect(exact.amount).toMatch(/^\d+\.\d{7}$/); // Matches 7 decimal places
  });

  it("handles maximum amount with 7 decimals (10,000,000 stroops = 1 USDC exactly)", () => {
    const oneUsdc = 10_000_000n;
    const exact = toExactUsdc(oneUsdc);
    expect(exact).toEqual({
      amount: "1.0000000",
      unit: UNIT_USDC_EXACT,
    });
    const display = toDisplayUsdc(oneUsdc);
    expect(display).toEqual({
      amount: "1.00",
      unit: UNIT_USDC,
    });
  });

  it("handles sub-stroop precision (none exists, validates 0 case)", () => {
    // Smallest meaningful unit is 1 stroop = 0.0000001 USDC
    const result = toExactUsdc(1n);
    expect(result.amount).toBe("0.0000001");
  });
});
