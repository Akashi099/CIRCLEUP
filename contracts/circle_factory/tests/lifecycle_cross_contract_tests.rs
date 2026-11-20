//! Cross-contract invariant suite for complete circle lifecycles (#886).
//!
//! Exercises factory creation/registry, member collateral locks, round contributions,
//! payouts, reputation scoring, default settlements, and collateral release on close.
//!
//! Invariants verified across participating contracts:
//!  1. Token conservation:
//!     - Full success: Circle contract balance reaches exactly 0 stroops upon close;
//!       sum of member balances equals initial minted supply (zero-sum ROSCA).
//!     - Default path: Circle contract balance holds strictly the forfeited penalties;
//!       all unpenalized collateral is restored to members. Total token supply is conserved.
//!  2. Recipient order & single payout:
//!     - Each member receives the scheduled pot exactly once in strict rotation order.
//!  3. Reputation atomicity:
//!     - Reputation increments exclusively upon completed round payout or exceptional settlement.
//!     - No reputation is awarded for non-completion or premature calls.
//!  4. Failure rollback:
//!     - Injected dependency failure (e.g. revoked reputation authorization) rolls back
//!       the entire transaction atomically: token balances, round counters, paid_out flags,
//!       and reputation scores remain unchanged.

use circle::{
    CircleContract, CircleContractClient, CircleStatus,
    COLLATERAL_MULTIPLIER, PENALTY_BPS, BPS_DENOM,
};
use circle_factory::{CircleFactory, CircleFactoryClient, DataKey as FactoryDataKey, registry};
use reputation::{ReputationContract, ReputationContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, Vec,
};

pub const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC (7 decimals)
pub const ROUND_DEADLINE_LEDGERS: u32 = 100;

pub struct LifecycleHarness<'a> {
    pub env: Env,
    pub factory: CircleFactoryClient<'a>,
    pub factory_id: Address,
    pub rep: ReputationContractClient<'a>,
    pub rep_id: Address,
    pub rep_admin: Address,
    pub token: TokenClient<'a>,
    pub asset: StellarAssetClient<'a>,
    pub usdc_id: Address,
    pub circle: CircleContractClient<'a>,
    pub circle_id: Address,
    pub members: Vec<Address>,
    pub round_amount: i128,
    pub deadline_ledgers: u32,
    pub initial_member_balance: i128,
}

impl<'a> LifecycleHarness<'a> {
    pub fn new(member_count: u32) -> Self {
        Self::new_with_reputation(member_count, true)
    }

    pub fn new_with_reputation(member_count: u32, authorize_reputation: bool) -> Self {
        let env = Env::default();
        env.mock_all_auths();

        // 1. Deploy & initialize USDC token test double
        let token_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(token_admin);
        let usdc_id = sac.address();
        let token = TokenClient::new(&env, &usdc_id);
        let asset = StellarAssetClient::new(&env, &usdc_id);

        // 2. Deploy & initialize Reputation contract
        let rep_id = env.register(ReputationContract, ());
        let rep = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep.initialize(&rep_admin);

        // 3. Deploy & initialize Factory contract
        let factory_id = env.register(CircleFactory, ());
        let factory = CircleFactoryClient::new(&env, &factory_id);
        let factory_admin = Address::generate(&env);
        let dummy_wasm: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        factory.initialize(&factory_admin, &dummy_wasm, &usdc_id, &rep_id);

        // 4. Generate and fund members
        let round_amount = ROUND_AMOUNT;
        let collateral = round_amount * COLLATERAL_MULTIPLIER;
        let per_member_budget = collateral + (round_amount * member_count as i128) + 50_000_000;
        let mut members = Vec::new(&env);
        for _ in 0..member_count {
            let m = Address::generate(&env);
            asset.mint(&m, &per_member_budget);
            members.push_back(m);
        }

        // 5. Deploy & initialize Circle contract directly
        let circle_id = env.register(CircleContract, ());
        let circle = CircleContractClient::new(&env, &circle_id);
        circle.initialize(
            &factory_id,
            &members,
            &round_amount,
            &usdc_id,
            &rep_id,
            &ROUND_DEADLINE_LEDGERS,
        );

        // 6. Register circle in factory registry and optionally authorize in reputation contract
        env.as_contract(&factory_id, || {
            let mut circles = registry::load(&env);
            let count: u32 = env.storage().instance().get(&FactoryDataKey::CircleCount).unwrap();
            registry::push(&env, &mut circles, count, circle_id.clone());
        });
        if authorize_reputation {
            rep.add_authorized_caller(&rep_admin, &circle_id);
        }

        LifecycleHarness {
            env,
            factory,
            factory_id,
            rep,
            rep_id,
            rep_admin,
            token,
            asset,
            usdc_id,
            circle,
            circle_id,
            members,
            round_amount,
            deadline_ledgers: ROUND_DEADLINE_LEDGERS,
            initial_member_balance: per_member_budget,
        }
    }

    pub fn advance_past_deadline(&self) {
        let current_round = self.circle.get_current_round();
        let target = current_round.deadline_ledger + 1;
        let current = self.env.ledger().sequence() as u64;
        if target > current {
            let bump = (target - current) as u32;
            self.env.ledger().with_mut(|l| l.sequence_number += bump);
        }
    }
}

// ─── Scenario 1: Deterministic 2-Member Complete Lifecycle ───────────────────

#[test]
fn test_deterministic_successful_lifecycle_two_members() {
    let h = LifecycleHarness::new(2);
    let m0 = h.members.get(0).unwrap();
    let m1 = h.members.get(1).unwrap();

    // Invariant Check 0: Factory registry contains circle
    let page = h.factory.get_circles_paginated(&0, &10);
    assert_eq!(page.total, 1);
    assert_eq!(page.circles.get(0).unwrap(), h.circle_id);

    // Initial state: circle is Pending, member reputation scores are 0
    assert_eq!(h.circle.get_status(), CircleStatus::Pending);
    assert_eq!(h.rep.score(&m0), 0);
    assert_eq!(h.rep.score(&m1), 0);

    // Step 1: Member Collateral Locks (Join)
    h.circle.join(&m0);
    assert_eq!(h.circle.get_status(), CircleStatus::Pending);
    assert_eq!(h.circle.get_collateral(&m0), h.round_amount * COLLATERAL_MULTIPLIER);

    h.circle.join(&m1);
    // Upon second member joining, circle transitions automatically to Active
    assert_eq!(h.circle.get_status(), CircleStatus::Active);
    assert_eq!(h.circle.get_collateral(&m1), h.round_amount * COLLATERAL_MULTIPLIER);
    assert_eq!(
        h.token.balance(&h.circle_id),
        2 * (h.round_amount * COLLATERAL_MULTIPLIER),
        "Circle contract holds locked collateral for both members"
    );

    // Step 2: Round 0 Contributions & Payout (Scheduled recipient: m0)
    let m0_bal_before_r0 = h.token.balance(&m0);
    let m1_bal_before_r0 = h.token.balance(&m1);

    h.circle.contribute(&m0);
    h.circle.contribute(&m1);
    let round_0 = h.circle.get_current_round();
    assert_eq!(round_0.round_index, 0);
    assert_eq!(round_0.recipient, m0);
    assert_eq!(round_0.contributions_received, 2);

    h.circle.payout();

    // Post-Round 0 Invariants:
    // - Recipient m0 received pot of 2 * ROUND_AMOUNT
    assert_eq!(h.token.balance(&m0), m0_bal_before_r0 - h.round_amount + 2 * h.round_amount);
    assert_eq!(h.token.balance(&m1), m1_bal_before_r0 - h.round_amount);
    // - Reputation updated for recipient m0 ONLY
    assert_eq!(h.rep.score(&m0), 1, "Scheduled recipient receives reputation increment on payout");
    assert_eq!(h.rep.score(&m1), 0, "Non-recipient reputation remains unchanged");

    // Step 3: Round 1 Contributions & Payout (Scheduled recipient: m1)
    let m0_bal_before_r1 = h.token.balance(&m0);
    let m1_bal_before_r1 = h.token.balance(&m1);

    let round_1 = h.circle.get_current_round();
    assert_eq!(round_1.round_index, 1);
    assert_eq!(round_1.recipient, m1);

    h.circle.contribute(&m0);
    h.circle.contribute(&m1);
    h.circle.payout();

    // Post-Round 1 Invariants:
    // - Recipient m1 received pot of 2 * ROUND_AMOUNT
    assert_eq!(h.token.balance(&m1), m1_bal_before_r1 - h.round_amount + 2 * h.round_amount);
    assert_eq!(h.token.balance(&m0), m0_bal_before_r1 - h.round_amount);
    // - Both members now have exactly 1 reputation point
    assert_eq!(h.rep.score(&m0), 1);
    assert_eq!(h.rep.score(&m1), 1);
    // - Circle status transitioned to Completed
    assert_eq!(h.circle.get_status(), CircleStatus::Completed);

    // Step 4: Collateral Release (Close)
    h.circle.close(&m0);

    // End-to-end Invariants:
    // 1. Circle Token Conservation: Circle contract balance reaches EXACTLY 0 stroops
    assert_eq!(
        h.token.balance(&h.circle_id),
        0,
        "Circle contract balance must be exactly 0 after complete lifecycle and close"
    );

    // 2. Zero-sum ROSCA balance conservation: Each member's final balance matches initial balance
    assert_eq!(
        h.token.balance(&m0),
        h.initial_member_balance,
        "Member 0 net balance delta must be exactly 0"
    );
    assert_eq!(
        h.token.balance(&m1),
        h.initial_member_balance,
        "Member 1 net balance delta must be exactly 0"
    );

    // 3. Repeated close rejected
    assert!(
        h.circle.try_close(&m0).is_err(),
        "Repeated close invocation must fail"
    );
}

// ─── Scenario 2: 4-Member Lifecycle With Default & Exceptional Settlement ───

#[test]
fn test_lifecycle_four_members_with_default_and_exceptional_settlement() {
    let h = LifecycleHarness::new(4);
    let m0 = h.members.get(0).unwrap();
    let m1 = h.members.get(1).unwrap();
    let m2 = h.members.get(2).unwrap();
    let m3 = h.members.get(3).unwrap();

    // All members join
    h.circle.join(&m0);
    h.circle.join(&m1);
    h.circle.join(&m2);
    h.circle.join(&m3);
    assert_eq!(h.circle.get_status(), CircleStatus::Active);

    let initial_circle_collateral = 4 * (h.round_amount * COLLATERAL_MULTIPLIER);
    assert_eq!(h.token.balance(&h.circle_id), initial_circle_collateral);

    // Round 0 (Recipient: m0)
    // m0, m2, m3 contribute; m1 DEFAULTS
    h.circle.contribute(&m0);
    h.circle.contribute(&m2);
    h.circle.contribute(&m3);

    // Advance past deadline
    h.advance_past_deadline();

    let m0_bal_before_settle = h.token.balance(&m0);

    // Exceptional settlement
    h.circle.settle_round();

    // Invariants post-settlement:
    // - m1 was penalized by PENALTY_BPS (20% of 100_000_000 = 20_000_000 stroops)
    let expected_penalty = (h.round_amount * COLLATERAL_MULTIPLIER * PENALTY_BPS) / BPS_DENOM;
    assert_eq!(expected_penalty, 20_000_000);
    assert_eq!(h.circle.get_collateral(&m1), (h.round_amount * COLLATERAL_MULTIPLIER) - expected_penalty);
    assert_eq!(h.circle.get_defaults(&m1), 1);

    // - Recipient m0 received partial pot (3 contributions = 300_000_000 stroops)
    assert_eq!(h.token.balance(&m0), m0_bal_before_settle + 3 * h.round_amount);
    // - Recipient m0 awarded reputation, m1 remains at 0
    assert_eq!(h.rep.score(&m0), 1);
    assert_eq!(h.rep.score(&m1), 0);

    // Complete remaining rounds:
    // Round 1 (Recipient: m1)
    h.circle.contribute(&m0);
    h.circle.contribute(&m1);
    h.circle.contribute(&m2);
    h.circle.contribute(&m3);
    h.circle.payout();
    assert_eq!(h.rep.score(&m1), 1);

    // Round 2 (Recipient: m2)
    h.circle.contribute(&m0);
    h.circle.contribute(&m1);
    h.circle.contribute(&m2);
    h.circle.contribute(&m3);
    h.circle.payout();
    assert_eq!(h.rep.score(&m2), 1);

    // Round 3 (Recipient: m3)
    h.circle.contribute(&m0);
    h.circle.contribute(&m1);
    h.circle.contribute(&m2);
    h.circle.contribute(&m3);
    h.circle.payout();
    assert_eq!(h.rep.score(&m3), 1);

    assert_eq!(h.circle.get_status(), CircleStatus::Completed);

    // Close circle
    h.circle.close(&m0);

    // Invariant 1 (Collateral return):
    // Non-defaulting members receive full collateral back
    // Defaulting member m1 receives remaining collateral (initial - penalty)
    let total_returned = h.token.balance(&m0) + h.token.balance(&m1) + h.token.balance(&m2) + h.token.balance(&m3);
    let total_initial = 4 * h.initial_member_balance;

    // Invariant 2 (Token conservation with penalties):
    // The tokens not returned to members must strictly reside in the circle contract balance
    let circle_residual_balance = h.token.balance(&h.circle_id);
    assert_eq!(
        circle_residual_balance,
        expected_penalty,
        "Circle balance must strictly equal forfeited penalties after close"
    );
    assert_eq!(
        total_returned + circle_residual_balance,
        total_initial,
        "Global token supply across all members and contract must be strictly conserved"
    );
}

// ─── Scenario 3: Boundary Failure Injection & State Rollback ─────────────────

#[test]
fn test_boundary_failure_injection_rolls_back_cross_contract_state() {
    // Initialize harness with circle NOT authorized in reputation contract
    let h = LifecycleHarness::new_with_reputation(2, false);
    let m0 = h.members.get(0).unwrap();
    let m1 = h.members.get(1).unwrap();

    h.circle.join(&m0);
    h.circle.join(&m1);

    h.circle.contribute(&m0);
    h.circle.contribute(&m1);

    // Take snapshot of observable state before failed invocation
    let circle_balance_before = h.token.balance(&h.circle_id);
    let m0_balance_before = h.token.balance(&m0);
    let m1_balance_before = h.token.balance(&m1);
    let rep_score_m0_before = h.rep.score(&m0);
    let round_before = h.circle.get_current_round();

    // Attempt payout — must fail due to unauthorized reputation increment
    let payout_result = h.circle.try_payout();
    assert!(payout_result.is_err(), "Payout must fail when dependency boundary rejects call");

    // Invariant: Cross-contract transaction rollback
    assert_eq!(
        h.token.balance(&h.circle_id),
        circle_balance_before,
        "Circle token balance must remain untouched on rollback"
    );
    assert_eq!(
        h.token.balance(&m0),
        m0_balance_before,
        "Recipient token balance must remain untouched on rollback"
    );
    assert_eq!(
        h.token.balance(&m1),
        m1_balance_before,
        "Member token balance must remain untouched on rollback"
    );
    assert_eq!(
        h.rep.score(&m0),
        rep_score_m0_before,
        "Reputation score must remain untouched on rollback"
    );
    let round_after = h.circle.get_current_round();
    assert_eq!(round_after.paid_out, false, "paid_out must remain false on rollback");
    assert_eq!(round_after.round_index, round_before.round_index, "round_index must not advance on rollback");

    // Self-healing: Authorize circle on reputation contract
    h.rep.add_authorized_caller(&h.rep_admin, &h.circle_id);

    // Retry payout — must now succeed cleanly
    h.circle.payout();
    assert_eq!(h.rep.score(&m0), 1, "Reputation incremented once after successful recovery");
    assert_eq!(h.circle.get_current_round().round_index, 1, "Round advanced cleanly after recovery");
}
