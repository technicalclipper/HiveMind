use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;
const T0: u64 = 1_700_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx_at(pred: &str, deposit: u128, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("core.testnet"))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1000))
        .block_timestamp(ts);
    testing_env!(b.build());
}

fn ctx(pred: &str, deposit: u128) {
    ctx_at(pred, deposit, T0 + 1_000_000_000);
}

fn hash(n: u32) -> String {
    format!("{n:064x}")
}

fn setup() -> Hivemind {
    ctx_at("owner.testnet", 0, T0);
    Hivemind::new(
        acc("evaluator.testnet"),
        "hf://Qwen/Qwen2.5-0.5B-Instruct".into(),
        2_000_000,
        None,
    )
}

fn setup_with_round() -> Hivemind {
    let mut c = setup();
    ctx_at("owner.testnet", 0, T0);
    c.start_round(60);
    c
}

fn submit(c: &mut Hivemind, who: &str, n: u32) -> u32 {
    ctx(who, 100 * MILLI);
    c.submit_contribution(format!("ipfs://adapter-{n}"), hash(n))
}

fn score(c: &mut Hivemind, id: u32, score: u64, safe: bool) -> bool {
    ctx("evaluator.testnet", 0);
    c.record_score(id, score, safe, None)
}

fn claimable(c: &Hivemind, who: &str) -> u128 {
    c.get_account(acc(who)).claimable.0
}

// ---------------------------------------------------------------------------

#[test]
fn init_publishes_base_model() {
    let c = setup();
    let m = c.get_latest_model();
    assert_eq!(m.version, 1);
    assert_eq!(m.eval_loss_micros, 2_000_000);
    assert_eq!(c.get_config().owner, acc("owner.testnet"));
    assert!(!c.get_stats().round_open);
}

#[test]
fn full_lifecycle() {
    let mut c = setup_with_round();

    // Fund the round with 1 NEAR.
    ctx("sponsor.testnet", NEAR);
    c.fund_rewards();
    assert_eq!(
        c.get_current_round().unwrap().reward_pool.as_yoctonear(),
        NEAR
    );

    let a = submit(&mut c, "alice.testnet", 1);
    let b = submit(&mut c, "bob.testnet", 2);
    let m = submit(&mut c, "mallory.testnet", 3);
    assert_eq!(c.get_pending_contributions().len(), 3);

    assert!(score(&mut c, a, 3000, true));
    assert!(score(&mut c, b, 1000, true));
    // Mallory improved loss but failed safety probes -> slashed.
    assert!(!score(&mut c, m, 500, false));

    assert_eq!(
        c.get_contribution(m).unwrap().status,
        ContributionStatus::Slashed
    );
    assert_eq!(c.get_stats().treasury.0, 100 * MILLI);
    assert_eq!(c.get_account(acc("alice.testnet")).shares.0, 3000);
    assert_eq!(c.get_account(acc("alice.testnet")).share_bps, 7500);
    assert!(c.get_pending_contributions().is_empty());

    // Finalize: new model version, reward pool paid 3:1.
    ctx("evaluator.testnet", 0);
    let v = c.finalize_round(Some("ipfs://model-v2".into()), Some(1_900_000), None);
    assert_eq!(v, Some(2));
    assert_eq!(c.get_latest_model().eval_loss_micros, 1_900_000);
    assert_eq!(c.get_latest_model().merged_contributions, vec![a, b]);
    assert_eq!(
        c.get_contribution(a).unwrap().status,
        ContributionStatus::Merged
    );
    assert_eq!(claimable(&c, "alice.testnet"), 750 * MILLI);
    assert_eq!(claimable(&c, "bob.testnet"), 250 * MILLI);

    // Operator + paid queries.
    ctx("operator.testnet", 100 * MILLI);
    c.register_operator();
    ctx("user.testnet", NEAR);
    c.buy_credits();
    assert_eq!(c.get_account(acc("user.testnet")).queries_available.0, 100);

    ctx("operator.testnet", 0);
    let left = c.charge(acc("user.testnet"), 10); // 10 x 0.01 = 0.1 NEAR
    assert_eq!(left.0, 900 * MILLI);

    // 70% of 0.1 NEAR = 0.07 split 3:1 between alice and bob.
    assert_eq!(
        claimable(&c, "alice.testnet"),
        750 * MILLI + 52_500 * MILLI / 1000
    );
    assert_eq!(
        claimable(&c, "bob.testnet"),
        250 * MILLI + 17_500 * MILLI / 1000
    );
    assert_eq!(claimable(&c, "operator.testnet"), 20 * MILLI);
    assert_eq!(c.get_stats().treasury.0, 100 * MILLI + 10 * MILLI);
    assert_eq!(c.get_stats().total_queries.0, 10);

    // Claim zeroes the claimable balance but keeps lifetime earnings.
    ctx("alice.testnet", 0);
    let _ = c.claim();
    assert_eq!(claimable(&c, "alice.testnet"), 0);
    assert_eq!(
        c.get_account(acc("alice.testnet")).lifetime_earned.0,
        750 * MILLI + 52_500 * MILLI / 1000
    );

    let board = c.get_leaderboard(None);
    assert_eq!(board[0].account_id, acc("alice.testnet"));
    assert_eq!(board[0].accepted_contributions, 1);
    assert_eq!(board.len(), 2);
}

#[test]
fn late_contributor_does_not_get_earlier_royalties() {
    let mut c = setup_with_round();
    let a = submit(&mut c, "alice.testnet", 1);
    score(&mut c, a, 1000, true);

    ctx("operator.testnet", 100 * MILLI);
    c.register_operator();
    ctx("user.testnet", NEAR);
    c.buy_credits();
    ctx("operator.testnet", 0);
    c.charge(acc("user.testnet"), 10); // 0.07 NEAR to alice only

    let b = submit(&mut c, "bob.testnet", 2);
    score(&mut c, b, 1000, true);
    ctx("operator.testnet", 0);
    c.charge(acc("user.testnet"), 10); // 0.07 NEAR split 50/50

    assert_eq!(claimable(&c, "alice.testnet"), 70 * MILLI + 35 * MILLI);
    assert_eq!(claimable(&c, "bob.testnet"), 35 * MILLI);
}

#[test]
fn fees_before_any_shares_go_to_treasury() {
    let mut c = setup();
    ctx("operator.testnet", 100 * MILLI);
    c.register_operator();
    ctx("user.testnet", NEAR);
    c.buy_credits();
    ctx("operator.testnet", 0);
    c.charge(acc("user.testnet"), 1); // 0.01 NEAR
    assert_eq!(c.get_stats().treasury.0, 7 * MILLI + MILLI);
    assert_eq!(claimable(&c, "operator.testnet"), 2 * MILLI);
}

#[test]
fn round_without_accepted_rolls_pool_over() {
    let mut c = setup_with_round();
    ctx("sponsor.testnet", NEAR);
    c.fund_rewards();
    let m = submit(&mut c, "mallory.testnet", 1);
    score(&mut c, m, 0, true);

    ctx("evaluator.testnet", 0);
    assert_eq!(c.finalize_round(None, None, None), None);
    assert_eq!(c.get_latest_model().version, 1);
    assert_eq!(c.get_stats().next_round_pool.0, NEAR);

    ctx_at("owner.testnet", 0, T0 + 2_000_000_000);
    c.start_round(30);
    assert_eq!(
        c.get_current_round().unwrap().reward_pool.as_yoctonear(),
        NEAR
    );
    assert_eq!(c.get_current_round().unwrap().base_version, 1);
}

#[test]
fn set_base_eval_before_first_round() {
    let mut c = setup();
    ctx("evaluator.testnet", 0);
    c.set_base_eval(1_234_567, Some("ipfs://base".into()));
    assert_eq!(c.get_latest_model().eval_loss_micros, 1_234_567);
    assert_eq!(c.get_latest_model().uri, "ipfs://base");
}

#[test]
fn emits_nep297_events() {
    let mut c = setup_with_round();
    submit(&mut c, "alice.testnet", 1);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:")
        && l.contains("\"standard\":\"hivemind\"")
        && l.contains("\"event\":\"contribution_submitted\"")));
}

// ---- Failure cases ----

#[test]
#[should_panic(expected = "Adapter already submitted")]
fn duplicate_hash_rejected() {
    let mut c = setup_with_round();
    submit(&mut c, "alice.testnet", 1);
    submit(&mut c, "bob.testnet", 1);
}

#[test]
#[should_panic(expected = "Attach a stake of at least")]
fn stake_below_minimum_rejected() {
    let mut c = setup_with_round();
    ctx("alice.testnet", MILLI);
    c.submit_contribution("ipfs://x".into(), hash(1));
}

#[test]
#[should_panic(expected = "sha256 must be 64 hex characters")]
fn bad_hash_rejected() {
    let mut c = setup_with_round();
    ctx("alice.testnet", 100 * MILLI);
    c.submit_contribution("ipfs://x".into(), "not-a-hash".into());
}

#[test]
#[should_panic(expected = "Submission limit reached for this round")]
fn submission_cap_enforced() {
    let mut c = setup_with_round();
    for n in 1..=4 {
        submit(&mut c, "alice.testnet", n);
    }
}

#[test]
#[should_panic(expected = "Round submission window has closed")]
fn submission_after_round_end_rejected() {
    let mut c = setup_with_round();
    ctx_at("alice.testnet", 100 * MILLI, T0 + 61 * 60_000_000_000);
    c.submit_contribution("ipfs://x".into(), hash(1));
}

#[test]
#[should_panic(expected = "No round has been started")]
fn submission_without_round_rejected() {
    let mut c = setup();
    submit(&mut c, "alice.testnet", 1);
}

#[test]
#[should_panic(expected = "Only evaluator")]
fn only_evaluator_can_score() {
    let mut c = setup_with_round();
    let a = submit(&mut c, "alice.testnet", 1);
    ctx("alice.testnet", 0);
    c.record_score(a, 1_000_000, true, None);
}

#[test]
#[should_panic(expected = "Contribution already scored")]
fn cannot_score_twice() {
    let mut c = setup_with_round();
    let a = submit(&mut c, "alice.testnet", 1);
    score(&mut c, a, 10, true);
    score(&mut c, a, 10, true);
}

#[test]
#[should_panic(expected = "Score all pending contributions before finalizing")]
fn cannot_finalize_with_pending() {
    let mut c = setup_with_round();
    submit(&mut c, "alice.testnet", 1);
    ctx("evaluator.testnet", 0);
    c.finalize_round(Some("ipfs://v2".into()), Some(1), None);
}

#[test]
#[should_panic(expected = "Current round is not finalized yet")]
fn cannot_start_overlapping_rounds() {
    let mut c = setup_with_round();
    ctx("owner.testnet", 0);
    c.start_round(10);
}

#[test]
#[should_panic(expected = "Only registered operators can charge")]
fn only_operators_can_charge() {
    let mut c = setup();
    ctx("user.testnet", NEAR);
    c.buy_credits();
    ctx("random.testnet", 0);
    c.charge(acc("user.testnet"), 1);
}

#[test]
#[should_panic(expected = "Insufficient credits")]
fn charge_requires_credits() {
    let mut c = setup();
    ctx("operator.testnet", 100 * MILLI);
    c.register_operator();
    ctx("operator.testnet", 0);
    c.charge(acc("user.testnet"), 1);
}

#[test]
#[should_panic(expected = "Nothing to claim")]
fn claim_with_nothing_panics() {
    let mut c = setup();
    ctx("alice.testnet", 0);
    let _ = c.claim();
}

#[test]
#[should_panic(expected = "Only owner")]
fn only_owner_can_start_round() {
    let mut c = setup();
    ctx("alice.testnet", 0);
    c.start_round(10);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn paused_blocks_submissions() {
    let mut c = setup_with_round();
    ctx("owner.testnet", 0);
    c.set_paused(true);
    submit(&mut c, "alice.testnet", 1);
}

#[test]
#[should_panic(expected = "Base model is locked once the first round starts")]
fn base_eval_locked_after_round_starts() {
    let mut c = setup_with_round();
    ctx("evaluator.testnet", 0);
    c.set_base_eval(1, None);
}
