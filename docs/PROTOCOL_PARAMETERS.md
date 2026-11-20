# CircleUp Protocol Parameters & Cross-Layer Traceability (#885)

This document provides the canonical specification of CircleUp protocol parameters, mapping authoritative smart contract values, client-side mirrors, enforcing layers, and governance change procedures.

---

## 1. Classification of Enforcing Layers

1. **`contract-authoritative`**: Enforced on-chain by Soroban smart contract logic and byte limits. Any client-side validation against these values is advisory to give instant user feedback before submitting an on-chain transaction.
2. **`advisory-client`**: Deliberately tightened client-side constraints (e.g., UI UX guardrails for mobile views and group coordination). Advisory values cannot loosen on-chain rules.
3. **`operational-configuration`**: Parameters governing backend services (such as indexer pagination, polling timeouts, connection pooling).
4. **`display-only`**: Constants used for visual formatting (e.g. converting stroops to USDC currency strings).

---

## 2. Canonical Protocol Parameter Inventory

| ID | Parameter | Authoritative Source | Value | Enforcing Layer | Client Mirror | Change Process |
|---|---|---|---|---|---|---|
| `max_members` | Maximum Circle Members | `contracts/circle/src/lib.rs` (`MAX_MEMBERS`) | `256` | `contract-authoritative` | `CONTRACT_MAX_MEMBERS` (`@circleup/sdk`) | Smart contract upgrade. Requires verifying Soroban instance storage byte budget. |
| `app_max_members` | Advisory UI Member Ceiling | `app/src/app/create/CreateClient.tsx` (`MAX_MEMBERS`) | `20` | `advisory-client` | `APP_MAX_MEMBERS` (`@circleup/sdk`) | Frontend UX review. Deliberately smaller than contract limit to keep ROSCA coordination manageable. |
| `min_members` | Minimum Circle Members | `contracts/circle/src/lib.rs` (`MIN_MEMBERS`) | `2` | `contract-authoritative` | `CONTRACT_MIN_MEMBERS` (`@circleup/sdk`) | Smart contract upgrade. |
| `min_round_deadline_ledgers` | Minimum Round Window | `contracts/circle/src/lib.rs` (`MIN_ROUND_DEADLINE_LEDGERS`) | `100` (~8.3 min) | `contract-authoritative` | `MIN_ROUND_DEADLINE_LEDGERS` (`@circleup/sdk`) | Smart contract redeployment / governance parameter change. |
| `max_round_deadline_ledgers` | Maximum Round Window | `contracts/circle/src/lib.rs` (`MAX_ROUND_DEADLINE_LEDGERS`) | `1_036_800` (~60 days) | `contract-authoritative` | `MAX_ROUND_DEADLINE_LEDGERS` (`@circleup/sdk`) | Smart contract redeployment / governance parameter change. |
| `collateral_multiplier` | Collateral Requirement | `contracts/circle/src/lib.rs` (`COLLATERAL_MULTIPLIER`) | `1` (1x round amount) | `contract-authoritative` | `COLLATERAL_MULTIPLIER` (`@circleup/sdk`) | Smart contract upgrade and collateral risk review. |
| `penalty_bps` | Default Penalty Basis Points | `contracts/circle/src/lib.rs` (`PENALTY_BPS`) | `2_000` (20%) | `contract-authoritative` | `PENALTY_BPS` / `DEFAULT_PENALTY_BPS` (`@circleup/sdk`) | Contract upgrade and economic risk policy change. |
| `bps_denom` | Basis Points Denominator | `contracts/circle/src/lib.rs` (`BPS_DENOM`) | `10_000` (100%) | `contract-authoritative` | `BPS_DENOM` (`@circleup/sdk`) | Immutable mathematical convention. |
| `usdc_decimals` | Token Decimals | Stellar Classic Asset Engine | `7` (10,000,000 stroops/USDC) | `contract-authoritative` | `USDC_DECIMALS` (`@circleup/sdk`) | Stellar standard token precision. |
| `factory_max_page_size` | Factory Page Size Ceiling | `contracts/circle_factory/src/registry.rs` (`MAX_PAGE_SIZE`) | `50` | `contract-authoritative` | `FACTORY_MAX_PAGE_SIZE` (`@circleup/sdk`) | Factory contract upgrade, bounded by transaction read bytes. |
| `indexer_max_page_size` | Indexer Page Size Ceiling | `indexer/src/api.ts` (`MAX_LIMIT`) | `100` | `operational-configuration` | `INDEXER_MAX_PAGE_SIZE` (`@circleup/sdk`) | Indexer REST service configuration. |

---

## 3. Automated Parity Verification

To prevent accidental drift between Rust smart contract constants and TypeScript/UI mirrors, an automated test is executed as part of CI:
- **Test file**: `tests/protocol-parameters-parity.test.ts`
- **Mechanism**: The test inspects Rust source files (`contracts/circle/src/lib.rs`, `contracts/circle_factory/src/registry.rs`), parses constant definitions, and asserts identity against `@circleup/sdk` constants and `PROTOCOL_PARAMETERS_INVENTORY`.
- If a developer alters a contract constant without updating the client mirror and inventory, the test fails with an explicit message identifying the mismatched symbol.

