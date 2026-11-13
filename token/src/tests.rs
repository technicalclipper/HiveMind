use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::testing_env;

const HIVE: u128 = 1_000_000_000_000_000_000; // 10^18

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(pred: &str, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("hive.testnet"))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

fn setup() -> HiveToken {
    ctx("owner.testnet", NearToken::from_yoctonear(0));
    HiveToken::new(acc("owner.testnet"), acc("core.testnet"))
}

#[test]
fn metadata_and_zero_supply() {
    let t = setup();
    let m = t.ft_metadata();
    assert_eq!(m.symbol, "HIVE");
    assert_eq!(m.decimals, 18);
    assert!(m.icon.unwrap().starts_with("data:image/svg+xml"));
    assert_eq!(t.ft_total_supply().0, 0);
    assert_eq!(t.get_minter(), acc("core.testnet"));
}

#[test]
fn minter_mints_and_auto_registers() {
    let mut t = setup();
    ctx("core.testnet", NearToken::from_yoctonear(0));
    t.ft_mint(
        acc("alice.testnet"),
        U128(30 * HIVE),
        Some("contribution 1".into()),
    );
    t.ft_mint(acc("alice.testnet"), U128(5 * HIVE), None);
    assert_eq!(t.ft_balance_of(acc("alice.testnet")).0, 35 * HIVE);
    assert_eq!(t.ft_total_supply().0, 35 * HIVE);
    assert!(t.storage_balance_of(acc("alice.testnet")).is_some());
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("\"event\":\"ft_mint\""))
    );
}

#[test]
fn holders_can_transfer() {
    let mut t = setup();
    ctx("core.testnet", NearToken::from_yoctonear(0));
    t.ft_mint(acc("alice.testnet"), U128(30 * HIVE), None);
    t.ft_mint(acc("bob.testnet"), U128(HIVE), None);
    ctx("alice.testnet", NearToken::from_yoctonear(1));
    t.ft_transfer(acc("bob.testnet"), U128(10 * HIVE), None);
    assert_eq!(t.ft_balance_of(acc("alice.testnet")).0, 20 * HIVE);
    assert_eq!(t.ft_balance_of(acc("bob.testnet")).0, 11 * HIVE);
}

#[test]
#[should_panic(expected = "Only the minter can mint")]
fn non_minter_cannot_mint() {
    let mut t = setup();
    ctx("alice.testnet", NearToken::from_yoctonear(0));
    t.ft_mint(acc("alice.testnet"), U128(HIVE), None);
}

#[test]
#[should_panic(expected = "Only owner")]
fn only_owner_sets_minter() {
    let mut t = setup();
    ctx("alice.testnet", NearToken::from_yoctonear(0));
    t.set_minter(acc("alice.testnet"));
}

#[test]
fn owner_can_change_minter() {
    let mut t = setup();
    ctx("owner.testnet", NearToken::from_yoctonear(0));
    t.set_minter(acc("core2.testnet"));
    assert_eq!(t.get_minter(), acc("core2.testnet"));
}
