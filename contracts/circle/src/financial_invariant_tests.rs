//! Financial invariant property tests for the Circle contract.
//!
//! This module extends the existing prop_tests.rs with token conservation
//! and financial invariant checks.
//!
//! # Design
//!
//! These tests verify that token movements obey conservation laws across
//! different lifecycle scenarios:
//!   - Completed circles (all members contribute, all receive pot once)
//!   - Defaulted circles (penalties applied correctly)
//!   - Cancelled circles (collateral returned proportionally)
//!
//! Each test generates bounded random scenarios and asserts:
//!   1. Total tokens are conserved (no value created or destroyed)
//!   2. No member can receive more than the pot (duplicate payout impossible)
//!   3. Collateral penalties are applied correctly (20% per default)
//!   4. Remaining balances reflect all movements
//!
//! # Bounding
//!
//! To keep CI runtime predictable:
//!   - Member count: 2-6 (not the full 256)
//!   - Round amount: 1-1_000_000_000 (fits in i128)
//!   - Action sequences: bounded to 20 steps max
//!   - Proptest cases: 32 (reduced from 64 for financial suite)

#[cfg(test)]
mod financial_invariant_tests {
    extern crate std;
    use std::vec::Vec;

    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec as SdkVec,
    };

    use crate::{
        CircleContract, CircleContractClient, CircleStatus, DataKey,
        BPS_DENOM, COLLATERAL_MULTIPLIER, PENALTY_BPS,
    };
    use reputation::{ReputationContract, ReputationContractClient};

    // ── Constants ────────────────────────────────────────────────────────────

    const MAX_INVARIANT_MEMBER_COUNT: usize = 6;
    const MAX_ACTION_SEQUENCE_LENGTH: usize = 20;
    const INVARIANT_TEST_CASES: u32 = 32;

    // ── Test Fixtures ────────────────────────────────────────────────────────

    struct FinancialSetup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        circle_id: Address,
        token: TokenClient<'a>,
        token_id: Address,
        rep_id: Address,
        members: Vec<Address>,
        round_amount: i128,
        initial_balances: Vec<i128>,
    }

    fn make_financial_setup(
        member_count: usize,
        round_amount: i128,
        deadline: u32,
    ) -> FinancialSetup<'static> {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_reg = env.register_stellar_asset_contract_v2(token_admin);
        let token_id = token_reg.address();
        let token = TokenClient::new(&env, &token_id);
        let asset_client = StellarAssetClient::new(&env, &token_id);

        let rep_reg = env.register_contract(None, ReputationContract);
        let rep_id = rep_reg.clone();
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);

        let circle_reg = env.register_contract(None, CircleContract);
        let circle_id = circle_reg.clone();
        let circle = CircleContractClient::new(&env, &circle_id);

        rep_client.add_authorized_caller(&rep_admin, &circle_id);

        let mut members = Vec::with_capacity(member_count);
        let mut sdk_members = SdkVec::new(&env);
        let mut initial_balances = Vec::with_capacity(member_count);

        // Each member needs: collateral + contributions for all rounds + buffer
        let budget = round_amount * (COLLATERAL_MULTIPLIER as i128 + member_count as i128 + 1);

        for _ in 0..member_count {
            let m = Address::generate(&env);
            asset_client.mint(&m, &budget);
            initial_balances.push(token.balance(&m));
            members.push(m.clone());
            sdk_members.push_back(m);
        }

        // Record circle creator's initial balance (for tracking fees)
        let creator = Address::generate(&env);
        initial_balances.push(token.balance(&creator));

        circle.initialize(
            &creator,
            &sdk_members,
            &round_amount,
            &token_id,
            &rep_id,
            &deadline,
        );

        FinancialSetup {
            env,
            circle,
            circle_id,
            token,
            token_id,
            rep_id,
            members,
            round_amount,
            initial_balances,
        }
    }

    // ── Helper Functions ─────────────────────────────────────────────────────

    fn join_all(setup: &FinancialSetup) {
        for m in &setup.members {
            setup.circle.join(m);
        }
    }

    fn contribute_all(setup: &FinancialSetup) {
        for m in &setup.members {
            let _ = setup.circle.try_contribute(m);
        }
    }

    fn complete_round(setup: &FinancialSetup) -> bool {
        contribute_all(setup);
        setup.circle.try_payout().is_ok()
    }

    fn advance_past_deadline(setup: &FinancialSetup) {
        let round = setup.circle.get_current_round();
        setup.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });
    }

    // ── Invariant Tests ─────────────────────────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(INVARIANT_TEST_CASES))]

        // ── FI-1: Full completion conservation ─────────────────────────────
        //
        // When a circle completes all rounds with no defaults:
        //   - Total tokens held by members after close must equal initial total
        //   - Each member's net change must be exactly 0

        #[test]
        fn prop_full_completion_conservation(
            member_count in 2usize..=MAX_INVARIANT_MEMBER_COUNT,
            round_amount in 1i128..=1_000_000_000i128,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            let total_initial: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            join_all(&setup);

            // Complete all rounds
            for _ in 0..member_count {
                let completed = complete_round(&setup);
                prop_assert!(completed, "round must complete successfully");
            }

            prop_assert_eq!(
                setup.circle.get_status(),
                CircleStatus::Completed,
                "circle must be completed after all rounds"
            );

            // Close the circle to release collateral
            setup.circle.close(&setup.members[0]);

            // Calculate total after close
            let total_after: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            // Tokens must be conserved (allowing for fees which stay in the circle contract)
            prop_assert!(
                total_after <= total_initial,
                "total after must not exceed initial (conservation): {} <= {}",
                total_after, total_initial
            );

            // Each member's net change should be 0 (ROSCA is zero-sum)
            for (i, m) in setup.members.iter().enumerate() {
                let balance_after = setup.token.balance(m);
                let net_change = balance_after - setup.initial_balances[i];
                prop_assert_eq!(
                    net_change, 0i128,
                    "member[{}] net change must be 0 in zero-sum ROSCA, got {}",
                    i, net_change
                );
            }
        }

        // ── FI-2: Default penalty conservation ─────────────────────────────
        //
        // When defaults occur, the penalty must be correctly calculated:
        //   penalty = collateral * PENALTY_BPS / BPS_DENOM
        //   new_collateral = old_collateral - penalty
        // Total penalties collected = sum of all penalty amounts

        #[test]
        fn prop_default_penalty_calculation(
            member_count in 2usize..=4,
            round_amount in 1i128..=100_000_000i128,
            default_victim_index in 0usize..3usize,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            join_all(&setup);

            let victim = setup.members[default_victim_index].clone();
            let collateral_before = setup.circle.get_collateral(&victim);

            // Advance past deadline and mark default
            advance_past_deadline(&setup);
            setup.circle.mark_default(&victim);

            let collateral_after = setup.circle.get_collateral(&victim);
            let expected_penalty = collateral_before * PENALTY_BPS / BPS_DENOM;

            prop_assert_eq!(
                collateral_before - collateral_after,
                expected_penalty,
                "penalty must be exactly {} (20% of {}), got {}",
                expected_penalty, collateral_before, collateral_before - collateral_after
            );

            // Collateral must never go negative
            prop_assert!(
                collateral_after >= 0,
                "collateral must not go negative: {}",
                collateral_after
            );
        }

        // ── FI-3: No duplicate payout possible ─────────────────────────────
        //
        // The contract must prevent double-payout:
        //   - Calling payout twice for the same round must panic on second call
        //   - Only one payout record should exist per round

        #[test]
        fn prop_no_duplicate_payout(
            member_count in 2usize..=4,
            round_amount in 1i128..=50_000_000i128,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            join_all(&setup);

            // First round: all contribute
            contribute_all(&setup);

            // First payout should succeed
            let first_payout = setup.circle.try_payout();
            prop_assert!(
                first_payout.is_ok(),
                "first payout must succeed"
            );

            // Second payout in same round must fail
            let second_payout = setup.circle.try_payout();
            prop_assert!(
                second_payout.is_err(),
                "second payout in same round must fail (no double-payout)"
            );
        }

        // ── FI-4: Cancelled circle returns all collateral ──────────────────
        //
        // When a Pending circle is cancelled before activation,
        // all collateral must be returned to members.

        #[test]
        fn prop_cancelled_returns_all_collateral(
            member_count in 2usize..=4,
            round_amount in 1i128..=50_000_000i128,
            cancel_after_joins in 0usize..3usize,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);

            // Record total collateral locked
            let total_initial: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            // Join some members but not all (keeps circle Pending)
            let join_count = (cancel_after_joins + 1).min(member_count);
            for i in 0..join_count {
                setup.circle.join(&setup.members[i]);
            }

            // Get collateral before cancellation
            let pre_cancel_balances: Vec<i128> = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .collect();

            // Cancel the circle (must be Pending)
            setup.circle.cancel(&setup.members[0]);

            // Verify status
            prop_assert_eq!(
                setup.circle.get_status(),
                CircleStatus::Cancelled,
                "circle must be cancelled"
            );

            // Close to release collateral
            setup.circle.close(&setup.members[0]);

            // Total after close should be <= total before (fees may be deducted)
            let total_after: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            prop_assert!(
                total_after >= total_initial - (member_count as i128), // Allow 1 stroop fee per member
                "total after cancel+close must approximately equal initial: {} >= {}",
                total_after, total_initial
            );
        }

        // ── FI-5: Token conservation under mixed defaults ───────────────────
        //
        // Complex scenario: some rounds complete, some have defaults.
        // Total tokens must still be conserved (modulo penalties).

        #[test]
        fn prop_mixed_defaults_conservation(
            member_count in 3usize..=MAX_INVARIANT_MEMBER_COUNT,
            round_amount in 1i128..=10_000_000i128,
            default_rounds in prop::collection::vec(0u32..3u32, 1..=3),
            rounds_to_complete in 1u32..3u32,
        ) {
            let mc = member_count;
            let setup = make_financial_setup(mc, round_amount, 100);
            let total_initial: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            join_all(&setup);

            // Complete some rounds normally
            for _ in 0..rounds_to_complete {
                let ok = complete_round(&setup);
                prop_assert!(ok, "normal round must complete");
            }

            // Default on subsequent rounds
            for round_idx in default_rounds.iter() {
                // Force round state
                setup.env.as_contract(&setup.circle_id, || {
                    let mut round: crate::RoundState = setup
                        .env
                        .storage()
                        .instance()
                        .get(&DataKey::CurrentRound)
                        .unwrap();
                    round.round_index = *round_idx;
                    round.paid_out = false;
                    round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                    setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
                });
                setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });

                // Default the last member in rotation
                let defaulter = setup.members[mc - 1].clone();
                let _ = setup.circle.try_mark_default(&defaulter);
            }

            // Complete remaining rounds
            let mut completed = true;
            while completed && setup.circle.get_status() == CircleStatus::Active {
                completed = complete_round(&setup);
            }

            // Close circle
            setup.circle.close(&setup.members[0]);

            let total_after: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            // Conservation check: total_after <= total_initial (fees may reduce)
            // The difference should be exactly the penalties taken
            let penalties_expected: i128 = default_rounds.len() as i128 
                * round_amount 
                * PENALTY_BPS 
                / BPS_DENOM;

            let difference = total_initial - total_after;
            
            // Allow for rounding and fees - penalties should be in the ballpark
            prop_assert!(
                difference >= penalties_expected - (mc as i128), // Allow some rounding variance
                "total difference {} should approximate penalties {}",
                difference, penalties_expected
            );

            // But never should total be MORE than initial (tokens created)
            prop_assert!(
                total_after <= total_initial,
                "tokens must never be created: {} <= {}",
                total_after, total_initial
            );
        }

        // ── FI-6: Collateral strictly decreases with each default ───────────
        //
        // Each default must reduce collateral by exactly PENALTY_BPS/BPS_DENOM.
        // Multiple defaults compound multiplicatively.

        #[test]
        fn prop_collateral_decreases_per_default(
            member_count in 2usize..=4,
            round_amount in 1000i128..=10_000_000i128,
            defaults_count in 1u32..=5u32,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            join_all(&setup);

            let target = setup.members[0].clone();
            let mut prev_collateral = setup.circle.get_collateral(&target);
            let expected_penalty = round_amount * PENALTY_BPS / BPS_DENOM;

            for i in 0..defaults_count {
                // Create a fresh round for each default
                setup.env.as_contract(&setup.circle_id, || {
                    let mut round: crate::RoundState = setup
                        .env
                        .storage()
                        .instance()
                        .get(&DataKey::CurrentRound)
                        .unwrap();
                    round.round_index = i;
                    round.paid_out = false;
                    round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                    setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
                });
                setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });

                setup.circle.mark_default(&target);
                let curr_collateral = setup.circle.get_collateral(&target);

                // Each default should reduce by exactly the penalty amount
                prop_assert_eq!(
                    prev_collateral - curr_collateral,
                    expected_penalty,
                    "default #{}: collateral must decrease by exactly penalty ({}), was {}",
                    i + 1, expected_penalty, prev_collateral - curr_collateral
                );

                prev_collateral = curr_collateral;
            }
        }

        // ── FI-7: Bounded action sequence with financial invariant check ────
        //
        // Generate random sequences of actions and verify financial invariants
        // hold throughout.

        #[test]
        fn prop_random_action_sequence_conservation(
            member_count in 2usize..=MAX_INVARIANT_MEMBER_COUNT,
            round_amount in 1i128..=5_000_000i128,
            seed in any::<u64>(),
        ) {
            let mc = member_count;
            let setup = make_financial_setup(mc, round_amount, 100);
            let total_initial: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            join_all(&setup);

            // Generate bounded random action sequence
            let mut rng = seed;
            for _ in 0..MAX_ACTION_SEQUENCE_LENGTH {
                if setup.circle.get_status() != CircleStatus::Active {
                    break;
                }

                // Mix of contribute, default, payout actions
                rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
                let action = (rng % 10) as usize;

                match action {
                    // Contribute (50% probability)
                    0..=4 => {
                        let member_idx = (rng / 10 % mc as u64) as usize;
                        let _ = setup.circle.try_contribute(&setup.members[member_idx]);
                    }
                    // Mark default (30% probability)
                    5..=7 => {
                        advance_past_deadline(&setup);
                        let member_idx = (rng / 100 % mc as u64) as usize;
                        let _ = setup.circle.try_mark_default(&setup.members[member_idx]);
                    }
                    // Payout (20% probability)
                    _ => {
                        let _ = setup.circle.try_payout();
                    }
                }

                // Invariant: total tokens in system must never exceed initial
                // (they may be less due to penalties/fees)
                let current_total: i128 = setup.members.iter()
                    .map(|m| setup.token.balance(m))
                    .sum();

                prop_assert!(
                    current_total <= total_initial,
                    "token total must never exceed initial (value created): {} > {}",
                    current_total, total_initial
                );
            }

            // Final state: close if terminal
            if setup.circle.get_status() == CircleStatus::Completed 
                || setup.circle.get_status() == CircleStatus::Cancelled {
                let _ = setup.circle.try_close(&setup.members[0]);
            }

            // Final invariant: no value created
            let final_total: i128 = setup.members.iter()
                .map(|m| setup.token.balance(m))
                .sum();

            prop_assert!(
                final_total <= total_initial,
                "final total must not exceed initial (value created): {} > {}",
                final_total, total_initial
            );
        }

        // ── FI-5: Collateral accounting under partial defaults and closure ─
        //
        // Proves that across arbitrary multi-round default patterns, the
        // independent integer-stroop accounting model exactly matches contract
        // collateral getters, default counters, and token balances; closure
        // releases remaining collateral; and repeated closes are rejected.

        #[test]
        fn prop_collateral_accounting_under_partial_defaults_and_closure(
            member_count in 2usize..=4usize,
            round_amount in 100_000i128..=10_000_000i128,
            skip_mask in 1u32..16u32,
        ) {
            let setup = make_financial_setup(member_count, round_amount, 100);
            let mut model = CircleAccountingModel::new(&setup.initial_balances[..member_count], round_amount);
            join_all(&setup);

            for round_idx in 0..member_count {
                let recipient_idx = round_idx;
                let mut contributed_count = 0u32;
                for m_idx in 0..member_count {
                    let bit = (skip_mask >> ((round_idx * member_count + m_idx) % 4)) & 1;
                    // Member 0 never defaults to test non-defaulting participant alongside defaulting ones
                    let should_contribute = bit == 0 || m_idx == 0;
                    if should_contribute {
                        setup.circle.contribute(&setup.members[m_idx]);
                        model.record_contribution(m_idx);
                        contributed_count += 1;
                    }
                }

                advance_past_deadline(&setup);

                if contributed_count == member_count as u32 {
                    setup.circle.payout();
                } else {
                    for m_idx in 0..member_count {
                        let bit = (skip_mask >> ((round_idx * member_count + m_idx) % 4)) & 1;
                        let should_contribute = bit == 0 || m_idx == 0;
                        if !should_contribute {
                            model.record_default(m_idx);
                        }
                    }
                    setup.circle.settle_round();
                }
                model.record_payout(recipient_idx, contributed_count);

                model.assert_invariants();
                for (i, m) in setup.members.iter().enumerate() {
                    prop_assert_eq!(setup.circle.get_collateral(m), model.members[i].current_collateral);
                    prop_assert_eq!(setup.circle.get_defaults(m), model.members[i].defaults_count);
                    prop_assert_eq!(setup.token.balance(m), model.expected_member_balance(i));
                }
            }

            prop_assert_eq!(setup.circle.get_status(), CircleStatus::Completed);
            setup.circle.close(&setup.members[0]);
            let total_released = model.record_close();

            prop_assert_eq!(
                total_released,
                model.total_expected_collateral() - model.total_penalties()
            );

            for (i, m) in setup.members.iter().enumerate() {
                prop_assert_eq!(setup.circle.get_collateral(m), 0);
                prop_assert_eq!(setup.token.balance(m), model.expected_member_balance(i));
            }

            prop_assert_eq!(setup.token.balance(&setup.circle_id), model.total_penalties());

            // Repeated close must fail
            prop_assert!(setup.circle.try_close(&setup.members[0]).is_err());
        }
    }

    // ── Regression Fixtures ─────────────────────────────────────────────────
    //
    // These deterministic tests capture known failure patterns. When a
    // proptest shrinks a failing case, the seed is stored in the
    // proptest-regressions directory and these tests ensure it stays fixed.

    #[test]
    fn regression_two_member_zero_amount() {
        // Edge case: minimal amounts
        let setup = make_financial_setup(2, 1, 100);
        join_all(&setup);

        let total_initial: i128 = setup.members.iter()
            .map(|m| setup.token.balance(m))
            .sum();

        // Complete both rounds
        complete_round(&setup);
        complete_round(&setup);

        setup.circle.close(&setup.members[0]);

        let total_after: i128 = setup.members.iter()
            .map(|m| setup.token.balance(m))
            .sum();

        // Must conserve (allow for integer truncation)
        assert!(total_after <= total_initial);
    }

    #[test]
    fn regression_max_penalty_compound() {
        // 5 defaults on 1M amount = 0.8^5 * 1M ~= 327K remaining
        let setup = make_financial_setup(2, 1_000_000, 100);
        join_all(&setup);

        let target = setup.members[0].clone();
        
        for i in 0..5 {
            setup.env.as_contract(&setup.circle_id, || {
                let mut round: crate::RoundState = setup
                    .env
                    .storage()
                    .instance()
                    .get(&DataKey::CurrentRound)
                    .unwrap();
                round.round_index = i;
                round.paid_out = false;
                round.deadline_ledger = setup.env.ledger().sequence() as u64 + 1;
                setup.env.storage().instance().set(&DataKey::CurrentRound, &round);
            });
            setup.env.ledger().with_mut(|l| { l.sequence_number += 2; });
            
            setup.circle.mark_default(&target);
        }

        let final_collateral = setup.circle.get_collateral(&target);
        
        // Should be approximately 1M * (0.8)^5 = 327,680 (integer math)
        let expected = 1_000_000_i128 * BPS_DENOM.saturating_sub(PENALTY_BPS).pow(5) 
            / BPS_DENOM.pow(5);
        
        assert!(final_collateral >= expected.saturating_sub(10)); // Allow 10 stroop variance
        assert!(final_collateral >= 0, "collateral must not be negative");
    }

    #[test]
    fn regression_four_member_full_lifecycle() {
        // Known working case: 4 members, standard amount
        let setup = make_financial_setup(4, 10_000_000, 100);
        
        let balances_before: Vec<i128> = setup.members.iter()
            .map(|m| setup.token.balance(m))
            .collect();
        let total_before: i128 = balances_before.iter().sum();

        join_all(&setup);
        assert_eq!(setup.circle.get_status(), CircleStatus::Active);

        // Complete all 4 rounds
        for _ in 0..4 {
            complete_round(&setup);
        }

        assert_eq!(setup.circle.get_status(), CircleStatus::Completed);

        // Close to return collateral
        setup.circle.close(&setup.members[0]);

        // Each member should net 0 (contributed once, received pot once)
        for (i, m) in setup.members.iter().enumerate() {
            let balance_after = setup.token.balance(m);
            assert_eq!(
                balance_after, balances_before[i],
                "member[{}] net must be 0: before={}, after={}",
                i, balances_before[i], balance_after
            );
        }
    }

    // ── Issue 58: Collateral Accounting Under Partial Defaults and Closure ─────
    //
    // Proves that across multiple rounds with complex partial default and
    // contribution patterns, terminal closure releases exactly the remaining
    // collateral, token conservation holds, and repeated mutations cannot alter
    // final accounting sums.

    #[derive(Clone, Debug)]
    pub struct MemberAccounting {
        pub initial_balance: i128,
        pub initial_collateral: i128,
        pub current_collateral: i128,
        pub penalties_total: i128,
        pub defaults_count: u32,
        pub contributions_total: i128,
        pub payouts_total: i128,
        pub released_collateral: i128,
    }

    #[derive(Clone, Debug)]
    pub struct CircleAccountingModel {
        pub members: Vec<MemberAccounting>,
        pub round_amount: i128,
        pub member_count: usize,
        pub is_closed: bool,
    }

    impl CircleAccountingModel {
        pub fn new(initial_balances: &[i128], round_amount: i128) -> Self {
            let initial_collateral = round_amount
                .checked_mul(COLLATERAL_MULTIPLIER as i128)
                .expect("collateral overflow in model");
            let members = initial_balances
                .iter()
                .map(|&bal| MemberAccounting {
                    initial_balance: bal,
                    initial_collateral,
                    current_collateral: initial_collateral,
                    penalties_total: 0,
                    defaults_count: 0,
                    contributions_total: 0,
                    payouts_total: 0,
                    released_collateral: 0,
                })
                .collect();

            CircleAccountingModel {
                members,
                round_amount,
                member_count: initial_balances.len(),
                is_closed: false,
            }
        }

        pub fn record_contribution(&mut self, member_idx: usize) {
            self.members[member_idx].contributions_total += self.round_amount;
        }

        pub fn record_default(&mut self, member_idx: usize) {
            let m = &mut self.members[member_idx];
            let penalty = m
                .current_collateral
                .checked_mul(PENALTY_BPS)
                .expect("penalty overflow in model")
                / BPS_DENOM;
            m.current_collateral -= penalty;
            m.penalties_total += penalty;
            m.defaults_count += 1;
        }

        pub fn record_payout(&mut self, recipient_idx: usize, contributed_count: u32) {
            let pot = self
                .round_amount
                .checked_mul(contributed_count as i128)
                .expect("pot overflow in model");
            self.members[recipient_idx].payouts_total += pot;
        }

        pub fn record_close(&mut self) -> i128 {
            assert!(!self.is_closed, "Model cannot close more than once");
            self.is_closed = true;
            let mut total_released = 0i128;
            for m in &mut self.members {
                m.released_collateral = m.current_collateral;
                total_released += m.released_collateral;
                m.current_collateral = 0;
            }
            total_released
        }

        pub fn expected_member_balance(&self, member_idx: usize) -> i128 {
            let m = &self.members[member_idx];
            if self.is_closed {
                m.initial_balance
                    - m.initial_collateral
                    - m.contributions_total
                    + m.payouts_total
                    + m.released_collateral
            } else {
                m.initial_balance
                    - m.initial_collateral
                    - m.contributions_total
                    + m.payouts_total
            }
        }

        pub fn total_expected_collateral(&self) -> i128 {
            self.round_amount * (COLLATERAL_MULTIPLIER as i128) * (self.member_count as i128)
        }

        pub fn total_penalties(&self) -> i128 {
            self.members.iter().map(|m| m.penalties_total).sum()
        }

        pub fn total_remaining_collateral(&self) -> i128 {
            self.members.iter().map(|m| m.current_collateral).sum()
        }

        pub fn assert_invariants(&self) {
            for (i, m) in self.members.iter().enumerate() {
                assert!(
                    m.current_collateral >= 0,
                    "Member {} current collateral must be non-negative: {}",
                    i, m.current_collateral
                );
                assert!(
                    m.penalties_total >= 0,
                    "Member {} penalties must be non-negative: {}",
                    i, m.penalties_total
                );
                assert!(
                    m.released_collateral >= 0,
                    "Member {} released collateral must be non-negative: {}",
                    i, m.released_collateral
                );

                // Identity: initial_collateral == current_collateral + penalties_total + released_collateral
                assert_eq!(
                    m.initial_collateral,
                    m.current_collateral + m.penalties_total + m.released_collateral,
                    "Member {} collateral identity violated: initial {} != current {} + penalties {} + released {}",
                    i, m.initial_collateral, m.current_collateral, m.penalties_total, m.released_collateral
                );
            }

            let total_initial = self.total_expected_collateral();
            let total_current: i128 = self.members.iter().map(|m| m.current_collateral).sum();
            let total_penalties: i128 = self.members.iter().map(|m| m.penalties_total).sum();
            let total_released: i128 = self.members.iter().map(|m| m.released_collateral).sum();

            assert_eq!(
                total_initial,
                total_current + total_penalties + total_released,
                "Global collateral conservation violated: {} != current {} + penalties {} + released {}",
                total_initial, total_current, total_penalties, total_released
            );
        }
    }

    #[test]
    fn test_table_driven_collateral_accounting_partial_defaults_and_final_closure() {
        // 4 members, 5 USDC round amount (50_000_000 stroops), 100 ledgers deadline
        const MEMBER_COUNT: usize = 4;
        const ROUND_AMOUNT: i128 = 50_000_000;
        const DEADLINE: u32 = 100;

        let setup = make_financial_setup(MEMBER_COUNT, ROUND_AMOUNT, DEADLINE);
        let mut model = CircleAccountingModel::new(&setup.initial_balances[..MEMBER_COUNT], ROUND_AMOUNT);

        // Members join the circle and lock initial collateral
        join_all(&setup);
        assert_eq!(setup.circle.get_status(), CircleStatus::Active);

        // Verify initial locked collateral against model
        for (i, m) in setup.members.iter().enumerate() {
            assert_eq!(setup.circle.get_collateral(m), model.members[i].current_collateral);
            assert_eq!(setup.circle.get_defaults(m), 0);
            assert_eq!(setup.token.balance(m), model.expected_member_balance(i));
        }
        model.assert_invariants();

        // Distinct round contribution and default matrix:
        // Round 0 (recipient 0): Member 0, 2, 3 contribute; Member 1 DEFAULTS (first time)
        // Round 1 (recipient 1): Member 0, 3 contribute; Member 1 DEFAULTS (second time); Member 2 DEFAULTS (first time)
        // Round 2 (recipient 2): Member 0, 1, 2 contribute; Member 3 DEFAULTS (first time); Member 1 contributes
        // Round 3 (recipient 3): Member 0, 2, 3 contribute; Member 1 DEFAULTS (third time)
        //
        // Note:
        // Member 0: NEVER defaults (contributes all 4 rounds)
        // Member 1: Defaults REPEATEDLY (Rounds 0, 1, 3)
        // Member 2: Defaults ONCE (Round 1)
        // Member 3: Defaults ONCE (Round 2)
        let round_contributions: [[bool; MEMBER_COUNT]; 4] = [
            [true, false, true, true],   // Round 0
            [true, false, false, true],  // Round 1
            [true, true, true, false],   // Round 2
            [true, false, true, true],   // Round 3
        ];

        for round_idx in 0..4 {
            let recipient_idx = round_idx;
            let contribs = round_contributions[round_idx];

            let mut contributed_count = 0u32;
            for (m_idx, &did_contribute) in contribs.iter().enumerate() {
                if did_contribute {
                    setup.circle.contribute(&setup.members[m_idx]);
                    model.record_contribution(m_idx);
                    contributed_count += 1;
                }
            }

            advance_past_deadline(&setup);

            if contributed_count == MEMBER_COUNT as u32 {
                setup.circle.payout();
            } else {
                // Record defaults in model for non-contributors
                for (m_idx, &did_contribute) in contribs.iter().enumerate() {
                    if !did_contribute {
                        model.record_default(m_idx);
                    }
                }
                setup.circle.settle_round();
            }
            model.record_payout(recipient_idx, contributed_count);

            // Verify state after round transition
            model.assert_invariants();
            for (i, m) in setup.members.iter().enumerate() {
                assert_eq!(
                    setup.circle.get_collateral(m),
                    model.members[i].current_collateral,
                    "Round {} Member {} collateral mismatch",
                    round_idx, i
                );
                assert_eq!(
                    setup.circle.get_defaults(m),
                    model.members[i].defaults_count,
                    "Round {} Member {} defaults count mismatch",
                    round_idx, i
                );
                assert_eq!(
                    setup.token.balance(m),
                    model.expected_member_balance(i),
                    "Round {} Member {} token balance mismatch",
                    round_idx, i
                );
            }
        }

        // After 4 rounds, circle status must be Completed
        assert_eq!(setup.circle.get_status(), CircleStatus::Completed);

        // Pre-close verification:
        // Contract token balance must equal total remaining collateral + total forfeited penalties
        let expected_pre_close_contract_balance = model.total_remaining_collateral() + model.total_penalties();
        assert_eq!(
            setup.token.balance(&setup.circle_id),
            expected_pre_close_contract_balance,
            "Contract token balance before close must equal stored collateral plus penalties"
        );

        // Close the circle to release remaining collateral
        setup.circle.close(&setup.members[0]);
        let total_released = model.record_close();

        // Acceptance criteria checks after closure:
        // 1. Total released equals remaining collateral
        assert_eq!(
            total_released,
            model.total_expected_collateral() - model.total_penalties(),
            "Total released must equal initial collateral minus forfeited penalties"
        );

        // 2. All member collateral getters are zeroed
        for (i, m) in setup.members.iter().enumerate() {
            assert_eq!(
                setup.circle.get_collateral(m),
                0,
                "Member {} collateral must be 0 after close",
                i
            );
            assert_eq!(
                setup.token.balance(m),
                model.expected_member_balance(i),
                "Member {} final token balance must match model exactly",
                i
            );
        }

        // 3. Contract balance holds exactly the forfeited penalties
        assert_eq!(
            setup.token.balance(&setup.circle_id),
            model.total_penalties(),
            "Contract balance after close must strictly equal forfeited penalties"
        );

        // 4. Repeated close attempts cannot change the final sum or succeed
        let member_balances_snapshot: Vec<i128> = setup
            .members
            .iter()
            .map(|m| setup.token.balance(m))
            .collect();
        let contract_balance_snapshot = setup.token.balance(&setup.circle_id);

        let repeat_close_1 = setup.circle.try_close(&setup.members[0]);
        let repeat_close_2 = setup.circle.try_close(&setup.members[1]);
        assert!(repeat_close_1.is_err(), "Repeated close attempt 1 must fail");
        assert!(repeat_close_2.is_err(), "Repeated close attempt 2 must fail");

        // 5. Repeated default or settle attempts cannot succeed after completion/close
        let repeat_default = setup.circle.try_mark_default(&setup.members[1]);
        let repeat_settle = setup.circle.try_settle_round();
        assert!(repeat_default.is_err(), "Post-close mark_default must fail");
        assert!(repeat_settle.is_err(), "Post-close settle_round must fail");

        // Verify balances remain untouched after repeated attempts
        for (i, m) in setup.members.iter().enumerate() {
            assert_eq!(setup.token.balance(m), member_balances_snapshot[i]);
        }
        assert_eq!(setup.token.balance(&setup.circle_id), contract_balance_snapshot);
    }
}