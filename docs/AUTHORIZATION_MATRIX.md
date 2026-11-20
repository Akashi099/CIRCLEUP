# CircleUp Public Mutation Authorization Matrix

This document provides the canonical authorization matrix for every public mutation across CircleUp's three Soroban smart contracts (`circle`, `circle_factory`, `reputation`). It specifies the exact authorizing principal, state transitions, rejection semantics, and architectural justifications for permissionless operations.

---

## 1. Summary of Mutation Authorization Model

Soroban implements cryptographic **authorization trees** via `Address::require_auth()` and `Address::require_auth_for_args()`.
1. **Wallet-Controlled Mutations**: Require explicit cryptographic authorization from the interacting wallet (`member`, `creator`, `admin`, or `closer`).
2. **Cross-Contract Invocations**: Use Soroban's Contract Invoker authentication. For example, when `circle` invokes `reputation.increment(circle, member)`, `reputation` verifies that `circle.require_auth()` succeeds and that `circle` is an authorized caller registered in storage.
3. **Permissionless Settlement Actions**: Explicitly omit caller authorization requirements. This allows anyone (keepers, relayers, automated off-chain bots, or other circle members) to execute scheduled or deadline-triggered state transitions without privilege.

---

## 2. Complete Authorization Matrix

### A. Circle Contract (`contracts/circle/src/lib.rs`)

| Mutation Method | Authorizing Principal (`require_auth`) | Permitted Actors | State & Balance Mutations on Success | Rejection Semantics on Missing/Incorrect Auth |
|---|---|---|---|---|
| `initialize(admin, usdc_token, reputation, members, round_amount, round_deadline_ledgers)` | `admin.require_auth()` | Deployer / Circle Admin | Writes `Admin`, `UsdcToken`, `ReputationContract`, `Config`, `Status::Pending`, `CurrentRound`, `RoundsCompleted`. | Traps with host authorization failure. Zero storage entries written. |
| `join(member)` | `member.require_auth()` | Circle Member (must be in `config.members`) | Debits `COLLATERAL` from `member`; credits `COLLATERAL` to `circle_id`; writes `Collateral(member)`. If last member: transitions to `Active`. | Rejects if caller is not `member` or not in `config.members`. Balances and storage byte-for-byte unchanged. |
| `cancel(caller)` | `caller.require_auth()` | `admin` OR any `member` | Transitions `Status` from `Pending` to `Cancelled`. | Rejects if caller is neither admin nor member, or if status != `Pending`. State unchanged. |
| `contribute(member)` | `member.require_auth()` | Active Circle Member | Debits `round_amount` from `member`; credits to `circle_id`; writes `Contributed(member, round)`; increments `CurrentRound.contributions_received`. | Rejects if not signed by `member`, or member not in circle, or deadline passed. Balances unchanged. |
| `payout()` | **Permissionless** (None) | Any caller (Keeper, Relayer, Member) | Transfers accumulated pot (`round_amount × member_count`) from `circle_id` to `CurrentRound.recipient`; invokes `reputation.increment(circle_id, recipient)`; advances or completes round. | Rejects with `IncompleteContributions` if not all members contributed; rejects if already paid out. State unchanged. |
| `mark_default(member)` | **Permissionless** (None) | Any caller (Keeper, Relayer, Member) | Deducts `PENALTY_BPS` (20%) from `Collateral(member)`; marks `Defaulted(member, round)` and bumps `Defaults(member)`. | Rejects if round deadline has not passed, or member already contributed, or already penalized for round. Collateral unchanged. |
| `settle_round()` | **Permissionless** (None) | Any caller (Keeper, Relayer, Member) | Distributes penalties or refunds; advances round index or completes circle if final round expired. | Rejects if called before round deadline or while paused. State unchanged. |
| `close(closer)` | `closer.require_auth()` | `admin` OR any `member` | Releases remaining collateral to each member; sets permanent `Closed` overlay flag. | Rejects if caller is not admin/member, or if circle status is neither `Completed` nor `Cancelled`. Collateral unchanged. |
| `pause(admin)` | `admin.require_auth()` | `config.admin` | Sets `Paused` flag to `true`. Halts financial mutations. | Rejects if caller != stored `Admin`. Pause flag unchanged. |
| `resume(admin)` | `admin.require_auth()` | `config.admin` | Sets `Paused` flag to `false`. | Rejects if caller != stored `Admin`. Pause flag unchanged. |

---

### B. CircleFactory Contract (`contracts/circle_factory/src/lib.rs`)

| Mutation Method | Authorizing Principal (`require_auth`) | Permitted Actors | State Mutations on Success | Rejection Semantics on Missing/Incorrect Auth |
|---|---|---|---|---|
| `initialize(admin, wasm_hash, rep_contract, usdc_token)` | `admin.require_auth()` | Factory Admin | Writes `Admin`, `CircleWasmHash`, `ReputationContract`, `UsdcToken`, `CircleCount(0)`, `Circles([])`. | Rejects without valid admin authorization. Storage uninitialized. |
| `create_circle(creator, members, round_amount, deadline)` | `creator.require_auth()` | Any wallet | Deploys new circle via deployer; calls `circle.initialize()`; calls `reputation.add_authorized_caller(circle_address)` using factory's admin authority; appends to `Circles` and increments `CircleCount`. | Rejects if not authorized by `creator`. Registry and reputation state completely untouched. |

---

### C. Reputation Contract (`contracts/reputation/src/lib.rs`)

| Mutation Method | Authorizing Principal (`require_auth`) | Permitted Actors | State Mutations on Success | Rejection Semantics on Missing/Incorrect Auth |
|---|---|---|---|---|
| `initialize(admin)` | `admin.require_auth()` | Deployer (typically CircleFactory) | Sets `Admin` to factory address; initializes empty `AuthorizedCallers` and `RevokedCallers`. | Rejects if admin authorization missing. |
| `add_authorized_caller(admin, circle)` | `admin.require_auth()` | Stored `Admin` (Factory) | Appends `circle` to `AuthorizedCallers` list; emits `caller_added`. | Rejects if caller != `DataKey::Admin`, or if `circle` was previously revoked (`CallerRevoked`). Allowlist unchanged. |
| `remove_authorized_caller(admin, circle)` | `admin.require_auth()` | Stored `Admin` (Factory) | Drops `circle` from `AuthorizedCallers`; records in `RevokedCallers` (permanent); emits `caller_removed`. | Rejects if caller != `DataKey::Admin`, or if circle not found. Caller lists unchanged. |
| `increment(circle, member)` | `circle.require_auth()` | Authorized `Circle` Contract | Increments `Score(member)` by 1; bumps persistent TTL; emits `score_updated`. | Rejects if `circle.require_auth()` fails, or if `circle` is not in `AuthorizedCallers`, or if `circle` is in `RevokedCallers`. Score unchanged. |

---

## 3. Deliberately Permissionless Operations Justification

The three settlement methods—`payout`, `mark_default`, and `settle_round`—are intentionally permissionless:
1. **Liveness & Non-Custodial Guarantee**: If settlement required member or admin signatures, a malicious or offline member/admin could withhold their signature and hold other members' funds hostage indefinitely.
2. **Keeper / Automation Compatibility**: Decentralized protocols rely on off-chain keepers or bots to trigger state transitions as soon as conditions are met (e.g. all contributions submitted, or round deadline expired).
3. **Idempotence & Strict Condition Guards**: Permissionless does not mean arbitrary. Each method verifies strict preconditions:
   - `payout()` verifies that all members have contributed for the round, recipient has not already been paid, and circle is active.
   - `mark_default()` verifies that ledger sequence `>` round deadline, member did NOT contribute, and member has not already been marked default for this round.
   - `settle_round()` verifies that ledger sequence `>` round deadline and circle is active.
   Unauthorized callers cannot alter amounts, redirect funds, or force premature settlement.

---

## 4. Nested Call Authorization Tree

When a user calls `create_circle`:
```text
Creator (signs create_circle)
└── factory.create_circle(creator, ...)
    ├── env.deployer().deploy(wasm_hash)
    ├── circle.initialize(factory_admin, ...)
    └── reputation.add_authorized_caller(factory, circle) [Factory is admin of reputation]
```

When a user calls `payout`:
```text
Any caller (no auth required)
└── circle.payout()
    ├── token.transfer(circle, recipient, pot_amount) [Circle contract funds]
    └── reputation.increment(circle, recipient) [Circle contract authorizes its own identity]
```

---

## 5. Test Suite Verification Reference

- Positive and negative authorization tests for `circle` mutations: `contracts/circle/src/adversarial_tests.rs` (32 tests).
- Positive and negative authorization tests for `circle_factory`: `contracts/circle_factory/src/lib.rs` (`test_initialize_requires_admin_auth`, `test_create_circle_requires_creator_auth`, adversarial batch tests).
- Positive and negative authorization tests for `reputation`: `contracts/reputation/src/lib.rs` (46 tests covering admin auth, caller auth, revoked caller rejection, and forged identity rejection).

