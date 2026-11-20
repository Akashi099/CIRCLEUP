/**
 * Protocol Parameter Parity Verification Suite (#885)
 *
 * Ensures that protocol parameter constants in Soroban Rust smart contracts
 * and TypeScript SDK/UI mirrors are strictly aligned.
 *
 * Run locally:
 *   node --experimental-strip-types --test tests/protocol-parameters-parity.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONTRACT_MAX_MEMBERS,
  CONTRACT_MIN_MEMBERS,
  APP_MAX_MEMBERS,
  MIN_ROUND_DEADLINE_LEDGERS,
  MAX_ROUND_DEADLINE_LEDGERS,
  COLLATERAL_MULTIPLIER,
  DEFAULT_PENALTY_BPS,
  PENALTY_BPS,
  BPS_DENOM,
  USDC_DECIMALS,
  FACTORY_MAX_PAGE_SIZE,
  PROTOCOL_PARAMETERS_INVENTORY,
} from "../sdk/src/constants.ts";

function extractRustConstant(filePath: string, constName: string): number {
  const fullPath = path.resolve(process.cwd(), filePath);
  const content = fs.readFileSync(fullPath, "utf8");
  // Match patterns like: pub const CONST_NAME: type = 123; or 1_000;
  const regex = new RegExp(`pub\\s+const\\s+${constName}\\s*:\\s*[a-zA-Z0-9_]+\\s*=\\s*([0-9_]+)\\s*;`);
  const match = content.match(regex);
  if (!match) {
    throw new Error(`Constant ${constName} not found in ${filePath}`);
  }
  return Number(match[1].replace(/_/g, ""));
}

describe("Protocol Parameter Traceability & Parity (#885)", () => {
  const circleRustPath = "contracts/circle/src/lib.rs";
  const factoryRegistryRustPath = "contracts/circle_factory/src/registry.rs";

  test("MAX_MEMBERS matches between contract and SDK", () => {
    const contractValue = extractRustConstant(circleRustPath, "MAX_MEMBERS");
    assert.strictEqual(CONTRACT_MAX_MEMBERS, contractValue);
    assert.strictEqual(CONTRACT_MAX_MEMBERS, 256);
  });

  test("MIN_ROUND_DEADLINE_LEDGERS matches between contract and SDK", () => {
    const contractValue = extractRustConstant(circleRustPath, "MIN_ROUND_DEADLINE_LEDGERS");
    assert.strictEqual(MIN_ROUND_DEADLINE_LEDGERS, contractValue);
    assert.strictEqual(MIN_ROUND_DEADLINE_LEDGERS, 100);
  });

  test("MAX_ROUND_DEADLINE_LEDGERS matches between contract and SDK", () => {
    const contractValue = extractRustConstant(circleRustPath, "MAX_ROUND_DEADLINE_LEDGERS");
    assert.strictEqual(MAX_ROUND_DEADLINE_LEDGERS, contractValue);
    assert.strictEqual(MAX_ROUND_DEADLINE_LEDGERS, 1_036_800);
  });

  test("COLLATERAL_MULTIPLIER matches between contract and SDK", () => {
    const contractValue = extractRustConstant(circleRustPath, "COLLATERAL_MULTIPLIER");
    assert.strictEqual(COLLATERAL_MULTIPLIER, contractValue);
    assert.strictEqual(COLLATERAL_MULTIPLIER, 1);
  });

  test("PENALTY_BPS and DEFAULT_PENALTY_BPS match between contract and SDK", () => {
    const contractValue = extractRustConstant(circleRustPath, "PENALTY_BPS");
    assert.strictEqual(PENALTY_BPS, contractValue);
    assert.strictEqual(DEFAULT_PENALTY_BPS, contractValue);
    assert.strictEqual(PENALTY_BPS, 2_000);
  });

  test("BPS_DENOM matches between contract and SDK", () => {
    const contractValue = extractRustConstant(circleRustPath, "BPS_DENOM");
    assert.strictEqual(BPS_DENOM, contractValue);
    assert.strictEqual(BPS_DENOM, 10_000);
  });

  test("FACTORY_MAX_PAGE_SIZE matches between factory contract and SDK", () => {
    const contractValue = extractRustConstant(factoryRegistryRustPath, "MAX_PAGE_SIZE");
    assert.strictEqual(FACTORY_MAX_PAGE_SIZE, contractValue);
    assert.strictEqual(FACTORY_MAX_PAGE_SIZE, 50);
  });

  test("App advisory limit APP_MAX_MEMBERS is valid subset of smart contract bounds", () => {
    assert.ok(
      APP_MAX_MEMBERS <= CONTRACT_MAX_MEMBERS,
      "Advisory app ceiling must not exceed on-chain architectural limit",
    );
    assert.ok(
      APP_MAX_MEMBERS >= CONTRACT_MIN_MEMBERS,
      "Advisory app ceiling must be at least minimum member count",
    );
    assert.strictEqual(APP_MAX_MEMBERS, 20);
  });

  test("PROTOCOL_PARAMETERS_INVENTORY entries match contract sources", () => {
    for (const item of PROTOCOL_PARAMETERS_INVENTORY) {
      if (item.enforcingLayer === "contract-authoritative" && item.contractSource) {
        const onChain = extractRustConstant(item.contractSource.file, item.contractSource.symbol);
        assert.strictEqual(
          item.contractSource.value,
          onChain,
          `Inventory value for ${item.id} must match Rust contract source`,
        );
        if (item.clientMirror) {
          assert.strictEqual(
            item.clientMirror.value,
            onChain,
            `Client mirror value for ${item.id} must match contract authoritative value`,
          );
        }
      }
    }
  });
});

