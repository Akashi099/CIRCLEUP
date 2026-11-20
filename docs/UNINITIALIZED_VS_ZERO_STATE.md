# Distinguishing Uninitialized Contract Reads from Valid Zero-Valued State

This document defines the contract storage behavior, return semantics, and SDK/indexer handling for every public getter across CircleUp's three Soroban smart contracts (`circle`, `circle_factory`, `reputation`).

## 1. Problem Statement

In Soroban storage, non-existent entries return `None` (`Option<Val>::None`). In smart contract implementations:
- Some getters use `.unwrap_or(0)` or `.unwrap_or(false)`, returning a default zero/empty result even when called on uninitialized contracts, for non-members, or before interaction.
- Other getters use `.unwrap()` or explicit error checks (e.g. `ok_or(ContractError::NotInitialized)` or `ok_or(ContractError::CircleNotActive)`), throwing typed contract errors or host traps when called out of sequence.

Without a typed, explicit distinction, presentation layers (frontend UI) and indexing reconciliation pipelines might mistake an absent score, an un-joined member's collateral, or a failed read for a valid financial zero (e.g., displaying "0 collateral remaining" instead of "collateral not locked", or "0 reputation" when the RPC call timed out).

---

## 2. Comprehensive Contract Getter Inventory

### A. Circle Contract (`contracts/circle`)

| Getter Method | Return Type | Storage Tier & Key | Pre-Initialization | Post-Initialization (Pending/Active) | Terminal State (Completed/Cancelled) | Closed State |
|---|---|---|---|---|---|---|
| `get_admin()` | `Result<Address, ContractError>` | Instance (`Admin`) | `Err(NotInitialized)` (1) | `Ok(admin_address)` | `Ok(admin_address)` | `Ok(admin_address)` |
| `get_usdc_token()` | `Result<Address, ContractError>` | Instance (`UsdcToken`) | `Err(NotInitialized)` (1) | `Ok(token_address)` | `Ok(token_address)` | `Ok(token_address)` |
| `get_protocol_params()` | `ProtocolParams` | Pure view (no storage) | Returns compile-time constants | Returns compile-time constants | Returns compile-time constants | Returns compile-time constants |
| `get_config()` | `Result<CircleConfig, ContractError>` | Instance (`Config`) | `Err(NotInitialized)` (1) | `Ok(CircleConfig)` | `Ok(CircleConfig)` | `Ok(CircleConfig)` |
| `get_status()` | `CircleStatus` | Instance (`Status`) | Panics ("get_status called before initialize") | `Pending` or `Active` | `Completed` or `Cancelled` | Status unchanged (`is_closed()` is true) |
| `get_current_round()` | `Result<RoundState, ContractError>` | Instance (`Status`, `CurrentRound`) | Panics ("get_current_round called before initialize") | `Ok(RoundState)` | `Err(CircleNotActive)` (2) | `Err(CircleNotActive)` (2) |
| `get_pot_amount()` | `Result<i128, ContractError>` | Instance (`Config`) | `Err(NotInitialized)` (1) | `Ok(round_amount × member_count)` | `Ok(round_amount × member_count)` | `Ok(round_amount × member_count)` |
| `get_collateral(member)` | `i128` | Persistent (`Collateral(member)`) | Returns `0` (`.unwrap_or(0)`) | Returns `0` if not joined; returns `COLLATERAL` once joined; reduced if penalized | Returns remaining collateral prior to `close()` | Returns `0` (released or forfeited during `close()`) |
| `get_defaults(member)` | `u32` | Persistent (`Defaults(member)`) | Returns `0` (`.unwrap_or(0)`) | Returns `0` if no defaults; `> 0` if penalized | Preserved default count | Preserved default count |
| `has_contributed(member, round)` | `bool` | Temporary (`Contributed(member, round)`) | Returns `false` | Returns `true` if contributed in round; `false` otherwise | Returns `false` (temporary storage expired or unwritten) | Returns `false` |
| `is_closed()` | `bool` | Instance (`Closed`) | Returns `false` (`.unwrap_or(false)`) | `false` | `false` (until `close()` is invoked) | `true` |
| `is_paused()` | `bool` | Instance (`Paused`) | Returns `false` (`.unwrap_or(false)`) | `true` if paused, `false` otherwise | `true` if paused, `false` otherwise | Preserved overlay flag |

### B. CircleFactory Contract (`contracts/circle_factory`)

| Getter Method | Return Type | Storage Tier & Key | Pre-Initialization | Post-Initialization | Notes |
|---|---|---|---|---|---|
| `get_admin()` | `Address` | Instance (`Admin`) | Panics ("not initialized") | `admin_address` | Fixed authority set at deploy |
| `get_usdc_token()` | `Address` | Instance (`UsdcToken`) | Panics ("not initialized") | `usdc_address` | Immutable token address |
| `get_reputation_contract()` | `Address` | Instance (`ReputationContract`) | Panics ("not initialized") | `reputation_address` | Immutable reputation address |
| `get_circle_wasm_hash()` | `BytesN<32>` | Instance (`CircleWasmHash`) | Panics ("not initialized") | `32-byte hash` | WASM byte code hash |
| `get_circle_count()` | `u32` | Instance (`CircleCount`) | Returns `0` (`.unwrap_or(0)`) | Monotonic count of created circles | Guaranteed `== get_circles().len()` |
| `get_circles()` | `Vec<Address>` | Instance (`Circles`) | Returns empty `Vec` | Full list of deployed circles | Append-only in creation order |
| `get_circles_paginated(cursor, limit)` | `Result<CirclePage, FactoryError>` | Instance (`Circles`, `CircleCount`) | Returns empty page | Returns windowed slice `[cursor..cursor+limit]` | Clamped to `MAX_PAGE_SIZE = 50` |

### C. Reputation Contract (`contracts/reputation`)

| Getter Method | Return Type | Storage Tier & Key | Pre-Initialization | Post-Initialization | Notes |
|---|---|---|---|---|---|
| `get_admin()` | `Address` | Instance (`Admin`) | Panics ("reputation: get_admin called before initialize") | `admin_address` | Set to factory address |
| `score(member)` | `u32` | Persistent (`Score(member)`) | Returns `0` (`.unwrap_or(0)`) | Returns completed rounds score (0 if never completed) | Monotonic; incremented only by authorized circles |
| `get_authorized_callers()` | `Vec<Address>` | Instance (`AuthorizedCallers`) | Returns empty `Vec` | List of authorized circle addresses | Admin-managed allowlist |
| `get_revoked_callers()` | `Vec<Address>` | Instance (`RevokedCallers`) | Returns empty `Vec` | List of permanently revoked addresses | Permanent revocation outranks allowlist |

---

## 3. SDK Typed Distinction: Confirmed Zero vs. State Unavailable

To ensure consumers never invent zero when a contract read fails or contract state is uninitialized:

### A. ReadResult<T> Discriminated Union
```typescript
export type ReadResult<T> = ReadSuccess<T> | ReadFailure;

export interface ReadSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ReadFailure {
  readonly ok: false;
  readonly error: string;
}
```

### B. Helper Predicates
1. `isConfirmedZero(result: ReadResult<bigint | number>): boolean`:
   Returns `true` **only** when `result.ok === true` and `result.value === 0` (or `0n`). If `result.ok === false`, it returns `false`, preventing UI from treating a failure as zero.
2. `isReadUninitialized<T>(result: ReadResult<T>): boolean`:
   Returns `true` when a read failed specifically because the contract is not initialized (`ContractError::NotInitialized`).
3. `isStateUnavailable<T>(result: ReadResult<T>): boolean`:
   Returns `true` when `result.ok === false` (simulation failure, transport failure, or decode error).

### C. Non-Throwing Method Availability
All read methods in `CircleClient` and `ReputationClient` offer typed result counterparts:
- `getConfigResult(): Promise<ReadResult<CircleConfig>>`
- `getStatusResult(): Promise<ReadResult<CircleStatus>>`
- `getCurrentRoundResult(): Promise<ReadResult<RoundState>>`
- `getPotAmountResult(): Promise<ReadResult<bigint>>`
- `getCollateralResult(member: string): Promise<ReadResult<bigint>>`
- `getDefaultsResult(member: string): Promise<ReadResult<number>>`
- `hasContributedResult(member: string, roundIndex: number): Promise<ReadResult<boolean>>`
- `ReputationClient.getScoreResult(member: string): Promise<ReadResult<number>>`

---

## 4. Guidelines for Presentation & Indexer Layers

1. **Collateral Status in UI**:
   - If `collateralResult.ok === false`: render **"Collateral Unavailable (RPC Error)"** or retry.
   - If `collateralResult.ok === true && collateralResult.value === 0n`:
     - Cross-reference `circleStatus`:
       - If `Pending`: member has **not yet joined** (collateral not locked).
       - If `Completed` or `Cancelled` and `isClosed`: member collateral was **successfully returned or forfeited**.
2. **Reputation Scores**:
   - If `getScoreResult.ok === false`: do NOT display `0 pts`; display placeholder skeleton or `—`.
   - If `getScoreResult.ok === true && getScoreResult.value === 0`: display `0 rounds completed` (confirmed zero).
3. **Indexer Reconciliation**:
   - When querying contract views to reconcile against event-derived state, the indexer must fail or retry reconciliation jobs when a read returns `ReadFailure`, rather than recording zero into database state.

