//! Mutation guard tests for CircleFactory contract (Issue #887).
//!
//! # Purpose
//!
//! Validates that security- and funds-critical guards in CircleFactory cannot be
//! bypassed or removed without failing test verification:
//! - Factory initialization single-use guard (`AlreadyInitialized`)
//! - Factory reentrancy guard (`InitializeInProgress`)
//! - Admin authorization requirement for initialization
//! - Creator authorization requirement for `create_circle`
//! - Duplicate member rejection (`DuplicateMembers`)
//! - Member count boundary constraints (< 2 and > 256)
//! - Round amount positive constraint and arithmetic overflow guards (`PotOverflow`, `PenaltyOverflow`)
//! - Deadline minimum and maximum ledger bounds

mod common;

use circle_factory::{
    CircleFactory, CircleFactoryClient, DataKey, FactoryError,
    MAX_MEMBERS, MIN_ROUND_DEADLINE_LEDGERS, MAX_ROUND_DEADLINE_LEDGERS,
};
use common::setup;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Vec};

fn make_members(env: &Env, count: u32) -> Vec<Address> {
    let mut v = Vec::new(env);
    for _ in 0..count {
        v.push_back(Address::generate(env));
    }
    v
}

#[test]
fn guard_factory_double_initialize_blocked() {
    let r = setup();
    let new_admin = Address::generate(&r.env);
    let wasm_hash = BytesN::from_array(&r.env, &[0x99u8; 32]);
    let result = r.client.try_initialize(
        &new_admin,
        &wasm_hash,
        &Address::generate(&r.env),
        &Address::generate(&r.env),
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for double initialize");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::AlreadyInitialized
    );
}

#[test]
fn guard_factory_reentrancy_in_progress_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, CircleFactory);
    let client = CircleFactoryClient::new(&env, &id);

    // Simulate active initialize in progress by pre-setting Initializing
    env.as_contract(&id, || {
        env.storage().instance().set(&DataKey::Initializing, &true);
    });

    let admin = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = client.try_initialize(
        &admin,
        &wasm_hash,
        &Address::generate(&env),
        &Address::generate(&env),
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for reentrant initialize");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::InitializeInProgress
    );
}

#[test]
fn guard_factory_admin_auth_required() {
    let env = Env::default();
    // Do NOT mock auths
    let id = env.register_contract(None, CircleFactory);
    let client = CircleFactoryClient::new(&env, &id);
    let admin = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let result = client.try_initialize(
        &admin,
        &wasm_hash,
        &Address::generate(&env),
        &Address::generate(&env),
    );
    assert!(result.is_err(), "unauthorized initialize must fail");
}

#[test]
fn guard_factory_creator_auth_required() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, CircleFactory);
    let client = CircleFactoryClient::new(&env, &id);
    let admin = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
    client.initialize(&admin, &wasm_hash, &Address::generate(&env), &Address::generate(&env));

    // Disable mocked auths for creator
    let members = make_members(&env, 3);
    let creator = Address::generate(&env);
    // An invocation without creator auth must fail
    env.mock_auths(&[]);
    let result = client.try_create_circle(
        &creator,
        &members,
        &100_000_000i128,
        &MIN_ROUND_DEADLINE_LEDGERS,
    );
    assert!(result.is_err(), "create_circle without creator auth must fail");
}

#[test]
fn guard_factory_duplicate_members_rejected() {
    let r = setup();
    let creator = Address::generate(&r.env);
    let a = Address::generate(&r.env);
    let b = Address::generate(&r.env);
    let mut members = Vec::new(&r.env);
    members.push_back(a.clone());
    members.push_back(b);
    members.push_back(a); // duplicate

    let result = r.client.try_create_circle(
        &creator,
        &members,
        &100_000_000i128,
        &MIN_ROUND_DEADLINE_LEDGERS,
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for duplicate members");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::DuplicateMembers
    );
}

#[test]
fn guard_factory_too_few_members_rejected() {
    let r = setup();
    let creator = Address::generate(&r.env);
    let mut members = Vec::new(&r.env);
    members.push_back(Address::generate(&r.env)); // only 1 member

    let result = r.client.try_create_circle(
        &creator,
        &members,
        &100_000_000i128,
        &MIN_ROUND_DEADLINE_LEDGERS,
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for too few members");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::TooFewMembers
    );
}

#[test]
fn guard_factory_too_many_members_rejected() {
    let r = setup();
    let creator = Address::generate(&r.env);
    let members = make_members(&r.env, MAX_MEMBERS + 1);

    let result = r.client.try_create_circle(
        &creator,
        &members,
        &100_000_000i128,
        &MIN_ROUND_DEADLINE_LEDGERS,
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for too many members");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::TooManyMembers
    );
}

#[test]
fn guard_factory_zero_round_amount_rejected() {
    let r = setup();
    let creator = Address::generate(&r.env);
    let members = make_members(&r.env, 3);

    let result = r.client.try_create_circle(
        &creator,
        &members,
        &0i128,
        &MIN_ROUND_DEADLINE_LEDGERS,
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for zero round_amount");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::InvalidRoundAmount
    );
}

#[test]
fn guard_factory_pot_overflow_checked() {
    let r = setup();
    let creator = Address::generate(&r.env);
    let members = make_members(&r.env, 2);

    let result = r.client.try_create_circle(
        &creator,
        &members,
        &i128::MAX,
        &MIN_ROUND_DEADLINE_LEDGERS,
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for pot overflow");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::PotOverflow
    );
}

#[test]
fn guard_factory_penalty_overflow_checked() {
    let r = setup();
    let creator = Address::generate(&r.env);
    let members = make_members(&r.env, 2);

    let result = r.client.try_create_circle(
        &creator,
        &members,
        &(i128::MAX / 1_000),
        &MIN_ROUND_DEADLINE_LEDGERS,
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for penalty overflow");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::PenaltyOverflow
    );
}

#[test]
fn guard_factory_deadline_minimum_checked() {
    let r = setup();
    let creator = Address::generate(&r.env);
    let members = make_members(&r.env, 2);

    let result = r.client.try_create_circle(
        &creator,
        &members,
        &100_000_000i128,
        &(MIN_ROUND_DEADLINE_LEDGERS - 1),
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for deadline below min");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::DeadlineBelowMinimum
    );
}

#[test]
fn guard_factory_deadline_maximum_checked() {
    let r = setup();
    let creator = Address::generate(&r.env);
    let members = make_members(&r.env, 2);

    let result = r.client.try_create_circle(
        &creator,
        &members,
        &100_000_000i128,
        &(MAX_ROUND_DEADLINE_LEDGERS + 1),
    );
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed FactoryError for deadline above max");
    };
    assert_eq!(
        FactoryError::try_from(sdk_error).expect("must be a typed FactoryError"),
        FactoryError::DeadlineAboveMaximum
    );
}

