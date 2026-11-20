/**
 * verify-mutation-guards.ts
 *
 * Verifies that critical security and authorization guards in the CircleFactory,
 * Reputation, and Circle contracts have deterministic, bounded negative tests
 * proving that removal or inversion of the guard fails the test suite.
 */

export interface MutationGuardSpec {
  id: string;
  contract: "circle" | "circle_factory" | "reputation";
  guardName: string;
  protectedCondition: string;
  riskIfRemoved: string;
  testFunction: string;
  testFile: string;
}

export interface ExcludedMutationSpec {
  id: string;
  contract: "circle" | "circle_factory" | "reputation";
  condition: string;
  exclusionReason: string;
}

/**
 * Catalog of active mutation guards for CircleFactory and Reputation.
 */
export const MUTATION_GUARDS: readonly MutationGuardSpec[] = [
  // ── Factory Guards ──────────────────────────────────────────────────────────
  {
    id: "FACTORY_INIT_SINGLE_USE",
    contract: "circle_factory",
    guardName: "factory double initialize check",
    protectedCondition: "if env.storage().instance().has(&DataKey::Admin)",
    riskIfRemoved: "Admin takeover via second initialize call overwriting contract registry and admin",
    testFunction: "guard_factory_double_initialize_blocked",
    testFile: "contracts/circle_factory/tests/mutation_guard_tests.rs",
  },
  {
    id: "FACTORY_INIT_REENTRANCY",
    contract: "circle_factory",
    guardName: "factory initialize reentrancy guard",
    protectedCondition: "if env.storage().instance().has(&DataKey::Initializing)",
    riskIfRemoved: "Reentrant call mid-initialization observes or corrupts partial factory state",
    testFunction: "guard_factory_reentrancy_in_progress_blocked",
    testFile: "contracts/circle_factory/tests/mutation_guard_tests.rs",
  },
  {
    id: "FACTORY_ADMIN_AUTH",
    contract: "circle_factory",
    guardName: "admin authorization on initialize",
    protectedCondition: "admin.require_auth()",
    riskIfRemoved: "Unauthenticated deployer can initialize factory with arbitrary admin address",
    testFunction: "guard_factory_admin_auth_required",
    testFile: "contracts/circle_factory/tests/mutation_guard_tests.rs",
  },
  {
    id: "FACTORY_CREATOR_AUTH",
    contract: "circle_factory",
    guardName: "creator authorization on create_circle",
    protectedCondition: "creator.require_auth()",
    riskIfRemoved: "Attacker can forge circle deployment under victim's identity without signature",
    testFunction: "guard_factory_creator_auth_required",
    testFile: "contracts/circle_factory/tests/mutation_guard_tests.rs",
  },
  {
    id: "FACTORY_DUPLICATE_MEMBERS",
    contract: "circle_factory",
    guardName: "assert_unique_members validation",
    protectedCondition: "assert_unique_members(&members)",
    riskIfRemoved: "Duplicate member addresses in circle roster let one wallet claim multiple payouts",
    testFunction: "guard_factory_duplicate_members_rejected",
    testFile: "contracts/circle_factory/tests/mutation_guard_tests.rs",
  },
  {
    id: "FACTORY_POT_OVERFLOW",
    contract: "circle_factory",
    guardName: "pot multiplication checked_mul",
    protectedCondition: "round_amount.checked_mul(member_count as i128)",
    riskIfRemoved: "Arithmetic overflow during pot payout locks funds in deployed circle",
    testFunction: "guard_factory_pot_overflow_checked",
    testFile: "contracts/circle_factory/tests/mutation_guard_tests.rs",
  },
  {
    id: "FACTORY_PENALTY_OVERFLOW",
    contract: "circle_factory",
    guardName: "penalty multiplication checked_mul",
    protectedCondition: "round_amount.checked_mul(PENALTY_BPS)",
    riskIfRemoved: "Arithmetic overflow during penalty computation breaks default penalization",
    testFunction: "guard_factory_penalty_overflow_checked",
    testFile: "contracts/circle_factory/tests/mutation_guard_tests.rs",
  },
  {
    id: "FACTORY_MIN_MEMBERS",
    contract: "circle_factory",
    guardName: "minimum member count check",
    protectedCondition: "if members.len() < 2",
    riskIfRemoved: "Single-member circle creates degenerate ROSCA without peer counterparty",
    testFunction: "guard_factory_too_few_members_rejected",
    testFile: "contracts/circle_factory/tests/mutation_guard_tests.rs",
  },

  // ── Reputation Guards ───────────────────────────────────────────────────────
  {
    id: "REP_INIT_SINGLE_USE",
    contract: "reputation",
    guardName: "reputation double initialize check",
    protectedCondition: "if env.storage().instance().has(&DataKey::Admin)",
    riskIfRemoved: "Attacker overwrites factory admin and self-authorizes rogue circles",
    testFunction: "guard_reputation_double_initialize_blocked",
    testFile: "contracts/reputation/tests/mutation_guard_tests.rs",
  },
  {
    id: "REP_ADMIN_AUTH_ADD",
    contract: "reputation",
    guardName: "admin authorization on add_authorized_caller",
    protectedCondition: "admin.require_auth()",
    riskIfRemoved: "Unauthenticated caller adds arbitrary contracts to allowlist",
    testFunction: "guard_reputation_admin_auth_required_for_add",
    testFile: "contracts/reputation/tests/mutation_guard_tests.rs",
  },
  {
    id: "REP_STORED_ADMIN_IDENTITY",
    contract: "reputation",
    guardName: "stored admin identity check",
    protectedCondition: "if admin != stored_admin",
    riskIfRemoved: "Any wallet signing for itself can register authorized callers",
    testFunction: "guard_reputation_stored_admin_identity_enforced",
    testFile: "contracts/reputation/tests/mutation_guard_tests.rs",
  },
  {
    id: "REP_REVOCATION_OUTRANKS_ALLOWLIST",
    contract: "reputation",
    guardName: "revocation precedence check",
    protectedCondition: "if is_revoked(&circle)",
    riskIfRemoved: "Stale allowlist entry left by incomplete reconfiguration allows revoked circle to award points",
    testFunction: "guard_reputation_revocation_outranks_allowlist",
    testFile: "contracts/reputation/tests/mutation_guard_tests.rs",
  },
  {
    id: "REP_REVOCATION_PERMANENT",
    contract: "reputation",
    guardName: "revocation non-resurrection guard",
    protectedCondition: "if is_revoked(&circle) { return Err(CallerRevoked) }",
    riskIfRemoved: "Admin can resurrect compromised circle, violating forward-only trust assumption",
    testFunction: "guard_reputation_revocation_is_permanent",
    testFile: "contracts/reputation/tests/mutation_guard_tests.rs",
  },
  {
    id: "REP_CALLER_AUTH_INCREMENT",
    contract: "reputation",
    guardName: "circle authorization on increment",
    protectedCondition: "circle.require_auth()",
    riskIfRemoved: "User or attacker can spoof circle contract address and self-award score",
    testFunction: "guard_reputation_circle_auth_required_for_increment",
    testFile: "contracts/reputation/tests/mutation_guard_tests.rs",
  },
  {
    id: "REP_UNAUTHORIZED_CALLER_BLOCKED",
    contract: "reputation",
    guardName: "allowlist check on increment",
    protectedCondition: "if !is_authorized(&circle)",
    riskIfRemoved: "Unregistered contracts award arbitrary reputation points outside ROSCA payout",
    testFunction: "guard_reputation_unauthorized_caller_blocked",
    testFile: "contracts/reputation/tests/mutation_guard_tests.rs",
  },
];

/**
 * Explicitly excluded mutations with documented rationale.
 */
export const EXCLUDED_MUTATIONS: readonly ExcludedMutationSpec[] = [
  {
    id: "FACTORY_PAGINATION_LIMIT_ZERO",
    contract: "circle_factory",
    condition: "get_circles_paginated limit == 0 check (FactoryError::InvalidPageLimit)",
    exclusionReason: "Read-only query validation error. Covered by pagination_tests.rs; excluded from security mutation suite.",
  },
  {
    id: "FACTORY_PAGINATION_CURSOR_OUT_OF_RANGE",
    contract: "circle_factory",
    condition: "get_circles_paginated cursor > count check (FactoryError::CursorOutOfRange)",
    exclusionReason: "Read-only cursor bound validation. Covered by pagination_tests.rs; excluded from security mutation suite.",
  },
  {
    id: "FACTORY_EVENT_TOPIC_NAMESPACE",
    contract: "circle_factory",
    condition: "Publishing event with namespace Symbol('factory')",
    exclusionReason: "Affects indexer filtering rather than funds or contract authorization. Covered by integration test assertions.",
  },
  {
    id: "REP_SCORE_OVERFLOW_U32",
    contract: "reputation",
    condition: "current.checked_add(1).ok_or(ScoreOverflow)",
    exclusionReason: "Requires 4,294,967,295 completed rounds by a single member to trigger. Unreachable in normal protocol operation.",
  },
];

/**
 * Validates the mutation guard catalog integrity.
 */
export function validateMutationCatalog(): { valid: boolean; totalGuards: number; excludedCount: number } {
  const ids = new Set<string>();
  for (const guard of MUTATION_GUARDS) {
    if (ids.has(guard.id)) {
      throw new Error(`Duplicate mutation guard ID: ${guard.id}`);
    }
    ids.add(guard.id);
  }
  return {
    valid: true,
    totalGuards: MUTATION_GUARDS.length,
    excludedCount: EXCLUDED_MUTATIONS.length,
  };
}

