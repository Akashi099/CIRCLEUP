//! Mutation guard tests for Reputation contract (Issue #887).
//!
//! # Purpose
//!
//! Validates that security- and funds-critical guards in Reputation contract cannot be
//! bypassed or removed without failing test verification:
//! - Initialization single-use guard (`AlreadyInitialized`)
//! - Reentrancy guard (`InitializeInProgress`)
//! - Admin authorization requirement for allowlist management
//! - Stored admin identity verification (`NotAdmin`)
//! - Revocation outranking allowlist (`CallerRevoked` precedence)
//! - Permanent revocation non-resurrection (`CallerRevoked` on re-add)
//! - Authorized caller cryptographic verification (`require_auth` on circle)
//! - Unauthorized caller rejection (`UnauthorizedCaller`)
//! - Monotonicity of scores (single point per increment, no reset)

use reputation::{DataKey, ReputationContract, ReputationContractClient, ReputationError};
use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

struct Fixture<'a> {
    env: Env,
    admin: Address,
    contract_id: Address,
    client: ReputationContractClient<'a>,
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    Fixture {
        env,
        admin,
        contract_id,
        client,
    }
}

#[test]
fn guard_reputation_double_initialize_blocked() {
    let f = setup();
    let second_admin = Address::generate(&f.env);
    let result = f.client.try_initialize(&second_admin);
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed ReputationError for double initialize");
    };
    assert_eq!(
        ReputationError::try_from(sdk_error).expect("must be a typed ReputationError"),
        ReputationError::AlreadyInitialized
    );
    // Stored admin remains original
    assert_eq!(f.client.get_admin(), f.admin);
}

#[test]
fn guard_reputation_reentrancy_in_progress_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);

    // Simulate reentrant initialize by pre-setting Initializing
    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::Initializing, &true);
    });

    let admin = Address::generate(&env);
    let result = client.try_initialize(&admin);
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed ReputationError for reentrant initialize");
    };
    assert_eq!(
        ReputationError::try_from(sdk_error).expect("must be a typed ReputationError"),
        ReputationError::InitializeInProgress
    );
}

#[test]
fn guard_reputation_admin_auth_required_for_add() {
    let f = setup();
    let circle = Address::generate(&f.env);

    // Disable mocked auth
    f.env.mock_auths(&[]);
    let result = f.client.try_add_authorized_caller(&f.admin, &circle);
    assert!(result.is_err(), "add_authorized_caller without admin auth must fail");
}

#[test]
fn guard_reputation_admin_auth_required_for_remove() {
    let f = setup();
    let circle = Address::generate(&f.env);
    f.client.add_authorized_caller(&f.admin, &circle);

    // Disable mocked auth
    f.env.mock_auths(&[]);
    let result = f.client.try_remove_authorized_caller(&f.admin, &circle);
    assert!(result.is_err(), "remove_authorized_caller without admin auth must fail");
}

#[test]
fn guard_reputation_stored_admin_identity_enforced() {
    let f = setup();
    let attacker = Address::generate(&f.env);
    let circle = Address::generate(&f.env);

    // Attacker signs for themselves, but is not the stored Admin
    let result = f.client.try_add_authorized_caller(&attacker, &circle);
    let Err(Ok(sdk_error)) = result else {
        panic!("expected typed ReputationError for non-admin add");
    };
    assert_eq!(
        ReputationError::try_from(sdk_error).expect("must be a typed ReputationError"),
        ReputationError::NotAdmin
    );
    assert_eq!(f.client.get_authorized_callers().len(), 0);
}

#[test]
fn guard_reputation_revocation_outranks_allowlist() {
    let f = setup();
    let circle = Address::generate(&f.env);
    let member = Address::generate(&f.env);

    // Register circle, then revoke it
    f.client.add_authorized_caller(&f.admin, &circle);
    f.client.remove_authorized_caller(&f.admin, &circle);

    // Manually force circle into AuthorizedCallers as well to simulate stale/inconsistent storage
    f.env.as_contract(&f.contract_id, || {
        let mut callers: Vec<Address> = f.env.storage().instance().get(&DataKey::AuthorizedCallers).unwrap();
        callers.push_back(circle.clone());
        f.env.storage().instance().set(&DataKey::AuthorizedCallers, &callers);
    });

    // Revocation check must fire: even though circle is in AuthorizedCallers, revocation rejects it!
    let result = f.client.try_increment(&circle, &member);
    let Err(Ok(sdk_error)) = result else {
        panic!("expected UnauthorizedCaller when circle is in both lists");
    };
    assert_eq!(
        ReputationError::try_from(sdk_error).expect("must be a typed ReputationError"),
        ReputationError::UnauthorizedCaller
    );
    assert_eq!(f.client.score(&member), 0);
}

#[test]
fn guard_reputation_revocation_is_permanent() {
    let f = setup();
    let circle = Address::generate(&f.env);
    f.client.add_authorized_caller(&f.admin, &circle);
    f.client.remove_authorized_caller(&f.admin, &circle);

    // Attempting to re-add a revoked caller must fail
    let result = f.client.try_add_authorized_caller(&f.admin, &circle);
    let Err(Ok(sdk_error)) = result else {
        panic!("expected CallerRevoked on re-add attempt");
    };
    assert_eq!(
        ReputationError::try_from(sdk_error).expect("must be a typed ReputationError"),
        ReputationError::CallerRevoked
    );
}

#[test]
fn guard_reputation_circle_auth_required_for_increment() {
    let f = setup();
    let circle = Address::generate(&f.env);
    let member = Address::generate(&f.env);
    f.client.add_authorized_caller(&f.admin, &circle);

    // Strip mock auths: caller cannot forge circle's signature
    f.env.mock_auths(&[]);
    let result = f.client.try_increment(&circle, &member);
    assert!(result.is_err(), "increment without circle auth must fail");
    assert_eq!(f.client.score(&member), 0);
}

#[test]
fn guard_reputation_unauthorized_caller_blocked() {
    let f = setup();
    let impostor = Address::generate(&f.env);
    let member = Address::generate(&f.env);

    let result = f.client.try_increment(&impostor, &member);
    let Err(Ok(sdk_error)) = result else {
        panic!("expected UnauthorizedCaller for unregistered circle");
    };
    assert_eq!(
        ReputationError::try_from(sdk_error).expect("must be a typed ReputationError"),
        ReputationError::UnauthorizedCaller
    );
    assert_eq!(f.client.score(&member), 0);
}

#[test]
fn guard_reputation_monotonic_increment() {
    let f = setup();
    let circle = Address::generate(&f.env);
    let member = Address::generate(&f.env);
    f.client.add_authorized_caller(&f.admin, &circle);

    assert_eq!(f.client.score(&member), 0);
    f.client.increment(&circle, &member);
    assert_eq!(f.client.score(&member), 1);
    f.client.increment(&circle, &member);
    assert_eq!(f.client.score(&member), 2);
}
