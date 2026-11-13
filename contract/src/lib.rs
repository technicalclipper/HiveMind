//! # Hivemind core contract
//!
//! A community-owned AI model on NEAR:
//! - Contributors submit LoRA adapters (by URI + sha256) with a slashable stake.
//! - The Arena evaluator scores each submission on a hidden eval set and safety probes.
//!   Accepted contributions earn royalty shares and get their stake back; rejected ones are slashed.
//! - At the end of a round, accepted adapters are merged into a new model version and the
//!   round's reward pool is paid out pro rata to score.
//! - Users prepay for queries. Every charged query splits its fee 70% contributors (by shares),
//!   20% the serving operator, 10% treasury.
//!
//! Royalties use a reward-per-share accumulator, so distributing fees never loops over holders.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env,
    ext_contract, near, require,
};

mod views;
pub use views::*;

#[cfg(test)]
mod tests;

/// Fixed-point scale for the reward-per-share accumulator.
pub const SCALE: u128 = 1_000_000_000_000;
pub const BPS_DENOM: u128 = 10_000;
/// Share of each query fee paid to contributors (by royalty shares).
pub const CONTRIBUTOR_BPS: u128 = 7_000;
/// Share of each query fee paid to the operator that served the query.
pub const OPERATOR_BPS: u128 = 2_000;
// The remaining 10% goes to the treasury.

const GAS_FOR_CLAIM_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_MINT: Gas = Gas::from_tgas(15);
/// $HIVE (18 decimals) minted per score micro: 1 HIVE per 0.001 of eval-loss improvement.
pub const HIVE_PER_SCORE_MICRO: u128 = 1_000_000_000_000_000;

/// The $HIVE token contract's mint method.
#[ext_contract(ext_hive_token)]
pub trait HiveTokenMinter {
    fn ft_mint(&mut self, account_id: AccountId, amount: U128, memo: Option<String>);
}

const GAS_FOR_UNWRAP: Gas = Gas::from_tgas(10);

/// The wNEAR contract's unwrap method.
#[ext_contract(ext_wrap)]
pub trait WrappedNear {
    fn near_withdraw(&mut self, amount: U128);
}

/// wNEAR contract for the network this contract runs on. Derived from the account suffix so no
/// state field is needed (adding one would change the stored layout).
pub fn wrap_account() -> AccountId {
    if env::current_account_id().as_str().ends_with(".testnet") {
        "wrap.testnet".parse().unwrap()
    } else {
        "wrap.near".parse().unwrap()
    }
}
const MAX_URI_LEN: usize = 512;
const MAX_ATTESTATION_LEN: usize = 1024;
const NS_PER_MINUTE: u64 = 60_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Rounds,
    Contributions,
    SeenHashes,
    SubmissionCounts,
    ModelVersions,
    Operators,
    Shares,
    RewardDebt,
    Pending,
    LifetimeEarned,
    Prepaid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ContributionStatus {
    /// Waiting for The Arena to score it.
    Pending,
    /// Improved the model and passed safety probes. Earning royalties.
    Accepted,
    /// Did not improve the model or failed safety probes. Stake sent to treasury.
    Slashed,
    /// Accepted and merged into a published model version.
    Merged,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Contribution {
    pub id: u32,
    pub round_id: u32,
    pub contributor: AccountId,
    pub adapter_uri: String,
    pub sha256: String,
    pub stake: NearToken,
    pub status: ContributionStatus,
    /// Eval loss improvement x 1e6 (base_loss - adapter_loss).
    pub score_micros: u64,
    pub safety_passed: bool,
    pub shares_minted: U128,
    /// $HIVE minted for this contribution (18 decimals).
    pub hive_minted: U128,
    /// Round reward paid when merged.
    pub reward: NearToken,
    /// Optional TEE attestation (or report hash) from the evaluator.
    pub attestation: Option<String>,
    pub submitted_at: U64,
    pub scored_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Round {
    pub id: u32,
    /// Model version contributors train against in this round.
    pub base_version: u32,
    pub started_at: U64,
    pub ends_at: U64,
    pub finalized: bool,
    pub reward_pool: NearToken,
    pub total_accepted_score: u64,
    pub contribution_ids: Vec<u32>,
    pub produced_version: Option<u32>,
    pub finalized_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ModelVersion {
    pub version: u32,
    pub uri: String,
    /// Mean loss on the hidden eval set x 1e6.
    pub eval_loss_micros: u64,
    pub round_id: Option<u32>,
    pub merged_contributions: Vec<u32>,
    pub attestation: Option<String>,
    pub created_at: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Hivemind {
    owner: AccountId,
    evaluator: AccountId,
    paused: bool,

    price_per_query: NearToken,
    min_stake: NearToken,
    operator_stake: NearToken,
    max_submissions_per_round: u32,

    rounds: Vector<Round>,
    contributions: Vector<Contribution>,
    seen_hashes: LookupSet<String>,
    /// "round_id:account_id" -> submissions this round.
    submission_counts: LookupMap<String, u32>,
    model_versions: Vector<ModelVersion>,

    /// Operator -> staked amount.
    operators: IterableMap<AccountId, NearToken>,

    /// Royalty shares per contributor.
    shares: IterableMap<AccountId, u128>,
    total_shares: u128,
    acc_reward_per_share: u128,
    reward_debt: LookupMap<AccountId, u128>,
    /// Claimable NEAR (settled royalties, round rewards, operator fees).
    pending: LookupMap<AccountId, u128>,
    lifetime_earned: LookupMap<AccountId, u128>,

    /// Prepaid query balance per user, in yoctoNEAR.
    prepaid: LookupMap<AccountId, u128>,

    treasury: u128,
    next_round_pool: u128,
    total_queries: u64,
    total_fees: u128,

    /// $HIVE token contract. When set, accepted contributions mint $HIVE.
    hive_token: Option<AccountId>,
}

pub(crate) fn emit(event: &str, data: Value) {
    let log = json!({
        "standard": "hivemind",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

#[near]
impl Hivemind {
    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------

    /// Deploy with the base model as version 1.
    #[init]
    pub fn new(
        evaluator: AccountId,
        base_model_uri: String,
        base_eval_loss_micros: u64,
        owner: Option<AccountId>,
        hive_token: Option<AccountId>,
    ) -> Self {
        require!(
            !base_model_uri.is_empty() && base_model_uri.len() <= MAX_URI_LEN,
            "Invalid model URI"
        );
        let owner = owner.unwrap_or_else(env::predecessor_account_id);
        let mut this = Self {
            owner,
            evaluator,
            paused: false,
            price_per_query: NearToken::from_millinear(10),
            min_stake: NearToken::from_millinear(100),
            operator_stake: NearToken::from_millinear(100),
            max_submissions_per_round: 3,
            rounds: Vector::new(StorageKey::Rounds),
            contributions: Vector::new(StorageKey::Contributions),
            seen_hashes: LookupSet::new(StorageKey::SeenHashes),
            submission_counts: LookupMap::new(StorageKey::SubmissionCounts),
            model_versions: Vector::new(StorageKey::ModelVersions),
            operators: IterableMap::new(StorageKey::Operators),
            shares: IterableMap::new(StorageKey::Shares),
            total_shares: 0,
            acc_reward_per_share: 0,
            reward_debt: LookupMap::new(StorageKey::RewardDebt),
            pending: LookupMap::new(StorageKey::Pending),
            lifetime_earned: LookupMap::new(StorageKey::LifetimeEarned),
            prepaid: LookupMap::new(StorageKey::Prepaid),
            treasury: 0,
            next_round_pool: 0,
            total_queries: 0,
            total_fees: 0,
            hive_token,
        };
        this.model_versions.push(ModelVersion {
            version: 1,
            uri: base_model_uri.clone(),
            eval_loss_micros: base_eval_loss_micros,
            round_id: None,
            merged_contributions: vec![],
            attestation: None,
            created_at: U64(env::block_timestamp()),
        });
        emit(
            "model_published",
            json!({ "version": 1, "uri": base_model_uri, "eval_loss_micros": base_eval_loss_micros, "round_id": null }),
        );
        this
    }

    // ------------------------------------------------------------------
    // Rounds
    // ------------------------------------------------------------------

    /// Open a new contribution round on top of the latest model version.
    pub fn start_round(&mut self, duration_minutes: u32) -> u32 {
        self.assert_owner();
        self.assert_not_paused();
        require!(duration_minutes > 0, "Duration must be positive");
        if let Some(last) = self.last_round() {
            require!(last.finalized, "Current round is not finalized yet");
        }
        let id = self.rounds.len() + 1;
        let now = env::block_timestamp();
        let pool = std::mem::take(&mut self.next_round_pool);
        let round = Round {
            id,
            base_version: self.model_versions.len(),
            started_at: U64(now),
            ends_at: U64(now + duration_minutes as u64 * NS_PER_MINUTE),
            finalized: false,
            reward_pool: NearToken::from_yoctonear(pool),
            total_accepted_score: 0,
            contribution_ids: vec![],
            produced_version: None,
            finalized_at: None,
        };
        emit(
            "round_started",
            json!({
                "round_id": id,
                "base_version": round.base_version,
                "ends_at": round.ends_at,
                "reward_pool": U128(pool),
            }),
        );
        self.rounds.push(round);
        id
    }

    /// Add NEAR to the open round's reward pool (or the next round's, if none is open).
    #[payable]
    pub fn fund_rewards(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach NEAR to fund rewards");
        let len = self.rounds.len();
        let open = len > 0 && !self.rounds.get(len - 1).unwrap().finalized;
        let round_id = if open {
            let r = self.rounds.get_mut(len - 1).unwrap();
            r.reward_pool = r
                .reward_pool
                .saturating_add(NearToken::from_yoctonear(amount));
            Some(r.id)
        } else {
            self.next_round_pool += amount;
            None
        };
        emit(
            "rewards_funded",
            json!({ "funder": env::predecessor_account_id(), "amount": U128(amount), "round_id": round_id }),
        );
    }

    // ------------------------------------------------------------------
    // Contributions
    // ------------------------------------------------------------------

    /// Submit a LoRA adapter for evaluation. Attach at least `min_stake`.
    #[payable]
    pub fn submit_contribution(&mut self, adapter_uri: String, sha256: String) -> u32 {
        self.assert_not_paused();
        let idx = self.open_round_index();
        let (round_id, ends_at) = {
            let r = self.rounds.get(idx).unwrap();
            (r.id, r.ends_at.0)
        };
        let now = env::block_timestamp();
        require!(now < ends_at, "Round submission window has closed");

        let stake = env::attached_deposit();
        require!(
            stake >= self.min_stake,
            format!("Attach a stake of at least {}", self.min_stake)
        );
        require!(
            !adapter_uri.is_empty() && adapter_uri.len() <= MAX_URI_LEN,
            "Invalid adapter URI"
        );
        let hash = sha256.to_lowercase();
        require!(
            hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()),
            "sha256 must be 64 hex characters"
        );
        require!(
            !self.seen_hashes.contains(&hash),
            "Adapter already submitted"
        );

        let contributor = env::predecessor_account_id();
        let key = format!("{round_id}:{contributor}");
        let count = self.submission_counts.get(&key).copied().unwrap_or(0);
        require!(
            count < self.max_submissions_per_round,
            "Submission limit reached for this round"
        );
        self.submission_counts.insert(key, count + 1);
        self.seen_hashes.insert(hash.clone());

        let id = self.contributions.len() + 1;
        self.contributions.push(Contribution {
            id,
            round_id,
            contributor: contributor.clone(),
            adapter_uri: adapter_uri.clone(),
            sha256: hash.clone(),
            stake,
            status: ContributionStatus::Pending,
            score_micros: 0,
            safety_passed: false,
            shares_minted: U128(0),
            hive_minted: U128(0),
            reward: NearToken::from_yoctonear(0),
            attestation: None,
            submitted_at: U64(now),
            scored_at: None,
        });
        self.rounds.get_mut(idx).unwrap().contribution_ids.push(id);

        emit(
            "contribution_submitted",
            json!({
                "contribution_id": id,
                "round_id": round_id,
                "contributor": contributor,
                "adapter_uri": adapter_uri,
                "sha256": hash,
                "stake": stake,
            }),
        );
        id
    }

    /// Evaluator only. Accept (score > 0 and safety passed) or slash a pending contribution.
    /// `score_micros` = (base eval loss - adapter eval loss) x 1e6, floored at 0 by the evaluator.
    pub fn record_score(
        &mut self,
        contribution_id: u32,
        score_micros: u64,
        safety_passed: bool,
        attestation: Option<String>,
    ) -> bool {
        self.assert_evaluator();
        if let Some(a) = &attestation {
            require!(a.len() <= MAX_ATTESTATION_LEN, "Attestation too long");
        }
        let cidx = self.contribution_index(contribution_id);
        let (contributor, stake, round_id) = {
            let c = self.contributions.get(cidx).unwrap();
            require!(
                c.status == ContributionStatus::Pending,
                "Contribution already scored"
            );
            (c.contributor.clone(), c.stake, c.round_id)
        };
        require!(
            !self.rounds.get(round_id - 1).unwrap().finalized,
            "Round already finalized"
        );

        let accepted = safety_passed && score_micros > 0;
        let shares = if accepted { score_micros as u128 } else { 0 };
        let hive = match &self.hive_token {
            Some(_) if accepted => shares * HIVE_PER_SCORE_MICRO,
            _ => 0,
        };
        let now = env::block_timestamp();
        {
            let c = self.contributions.get_mut(cidx).unwrap();
            c.status = if accepted {
                ContributionStatus::Accepted
            } else {
                ContributionStatus::Slashed
            };
            c.score_micros = score_micros;
            c.safety_passed = safety_passed;
            c.shares_minted = U128(shares);
            c.hive_minted = U128(hive);
            c.attestation = attestation;
            c.scored_at = Some(U64(now));
        }

        if accepted {
            self.add_shares(&contributor, shares);
            self.rounds
                .get_mut(round_id - 1)
                .unwrap()
                .total_accepted_score += score_micros;
            // Return the stake.
            let _ = Promise::new(contributor.clone()).transfer(stake);
            if let Some(token) = self.hive_token.clone() {
                let _ = ext_hive_token::ext(token)
                    .with_static_gas(GAS_FOR_MINT)
                    .ft_mint(
                        contributor.clone(),
                        U128(hive),
                        Some(format!("Hivemind contribution {contribution_id}")),
                    );
            }
        } else {
            self.treasury += stake.as_yoctonear();
        }

        emit(
            "contribution_scored",
            json!({
                "contribution_id": contribution_id,
                "round_id": round_id,
                "contributor": contributor,
                "accepted": accepted,
                "score_micros": score_micros,
                "safety_passed": safety_passed,
                "shares_minted": U128(shares),
                "hive_minted": U128(hive),
                "stake": stake,
                "stake_outcome": if accepted { "returned" } else { "slashed" },
            }),
        );
        accepted
    }

    /// Evaluator only. Close the open round. If any contribution was accepted, publish the merged
    /// model as a new version and pay the round reward pool pro rata to score. Otherwise the pool
    /// rolls over to the next round.
    pub fn finalize_round(
        &mut self,
        new_model_uri: Option<String>,
        new_eval_loss_micros: Option<u64>,
        attestation: Option<String>,
    ) -> Option<u32> {
        self.assert_evaluator();
        if let Some(a) = &attestation {
            require!(a.len() <= MAX_ATTESTATION_LEN, "Attestation too long");
        }
        let idx = self.open_round_index();
        let (round_id, ids, pool, total_score) = {
            let r = self.rounds.get(idx).unwrap();
            (
                r.id,
                r.contribution_ids.clone(),
                r.reward_pool.as_yoctonear(),
                r.total_accepted_score,
            )
        };

        let mut accepted: Vec<(u32, AccountId, u64)> = vec![];
        for id in &ids {
            let c = self.contributions.get(id - 1).unwrap();
            require!(
                c.status != ContributionStatus::Pending,
                "Score all pending contributions before finalizing"
            );
            if c.status == ContributionStatus::Accepted {
                accepted.push((c.id, c.contributor.clone(), c.score_micros));
            }
        }

        let now = env::block_timestamp();
        let produced = if accepted.is_empty() {
            require!(
                new_model_uri.is_none(),
                "No accepted contributions, so no new model version can be published"
            );
            self.next_round_pool += pool;
            None
        } else {
            let uri = new_model_uri.unwrap_or_else(|| env::panic_str("new_model_uri is required"));
            require!(
                !uri.is_empty() && uri.len() <= MAX_URI_LEN,
                "Invalid model URI"
            );
            let loss = new_eval_loss_micros
                .unwrap_or_else(|| env::panic_str("new_eval_loss_micros is required"));

            let mut distributed = 0u128;
            for (cid, acct, score) in &accepted {
                let reward = if total_score > 0 {
                    pool * (*score as u128) / total_score as u128
                } else {
                    0
                };
                distributed += reward;
                if reward > 0 {
                    self.credit(acct, reward);
                }
                let c = self.contributions.get_mut(cid - 1).unwrap();
                c.status = ContributionStatus::Merged;
                c.reward = NearToken::from_yoctonear(reward);
            }
            // Rounding dust goes to the treasury.
            self.treasury += pool - distributed;

            let version = self.model_versions.len() + 1;
            let merged: Vec<u32> = accepted.iter().map(|(id, _, _)| *id).collect();
            self.model_versions.push(ModelVersion {
                version,
                uri: uri.clone(),
                eval_loss_micros: loss,
                round_id: Some(round_id),
                merged_contributions: merged.clone(),
                attestation: attestation.clone(),
                created_at: U64(now),
            });
            emit(
                "model_published",
                json!({
                    "version": version,
                    "uri": uri,
                    "eval_loss_micros": loss,
                    "round_id": round_id,
                    "merged_contributions": merged,
                }),
            );
            Some(version)
        };

        {
            let r = self.rounds.get_mut(idx).unwrap();
            r.finalized = true;
            r.produced_version = produced;
            r.finalized_at = Some(U64(now));
        }
        emit(
            "round_finalized",
            json!({
                "round_id": round_id,
                "produced_version": produced,
                "accepted": accepted.len(),
                "reward_pool": U128(pool),
            }),
        );
        produced
    }

    // ------------------------------------------------------------------
    // Operators
    // ------------------------------------------------------------------

    /// Stake to become an inference operator.
    #[payable]
    pub fn register_operator(&mut self) {
        let op = env::predecessor_account_id();
        require!(!self.operators.contains_key(&op), "Already an operator");
        let stake = env::attached_deposit();
        require!(
            stake >= self.operator_stake,
            format!(
                "Attach an operator stake of at least {}",
                self.operator_stake
            )
        );
        self.operators.insert(op.clone(), stake);
        emit(
            "operator_registered",
            json!({ "operator": op, "stake": stake }),
        );
    }

    /// Stop operating and get the stake back. Earned fees stay claimable.
    pub fn unregister_operator(&mut self) -> Promise {
        let op = env::predecessor_account_id();
        let stake = self
            .operators
            .remove(&op)
            .unwrap_or_else(|| env::panic_str("Not an operator"));
        emit(
            "operator_unregistered",
            json!({ "operator": op, "stake": stake }),
        );
        Promise::new(op).transfer(stake)
    }

    // ------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------

    /// Prepay for queries. Returns the new prepaid balance.
    #[payable]
    pub fn buy_credits(&mut self) -> U128 {
        let user = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(
            amount >= self.price_per_query.as_yoctonear(),
            "Deposit at least the price of one query"
        );
        let balance = self.prepaid.get(&user).copied().unwrap_or(0) + amount;
        self.prepaid.insert(user.clone(), balance);
        emit(
            "credits_purchased",
            json!({
                "user": user,
                "amount": U128(amount),
                "balance": U128(balance),
                "queries_available": (balance / self.price_per_query.as_yoctonear()) as u64,
            }),
        );
        U128(balance)
    }

    /// Withdraw unused prepaid balance (all of it if `amount` is omitted).
    /// NEP-141 receiver: buy query credits with wNEAR, e.g. the output of a NEAR Intents swap from
    /// any token on any chain. `msg` may be empty (credit the sender) or `{"beneficiary": "<account>"}`.
    /// The wNEAR is unwrapped to native NEAR so all fee accounting stays in NEAR.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(
            token == wrap_account(),
            "Only wNEAR is accepted for credits"
        );
        self.assert_not_paused();
        require!(
            amount.0 >= self.price_per_query.as_yoctonear(),
            "Deposit at least the price of one query"
        );
        let beneficiary: AccountId = if msg.trim().is_empty() {
            sender_id.clone()
        } else {
            near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&msg)
                .ok()
                .and_then(|v| v.get("beneficiary")?.as_str()?.parse().ok())
                .unwrap_or_else(|| {
                    env::panic_str("msg must be empty or {\"beneficiary\": \"<account>\"}")
                })
        };
        let balance = self.prepaid.get(&beneficiary).copied().unwrap_or(0) + amount.0;
        self.prepaid.insert(beneficiary.clone(), balance);
        emit(
            "credits_purchased",
            json!({
                "user": beneficiary,
                "payer": sender_id,
                "amount": amount,
                "balance": U128(balance),
                "queries_available": (balance / self.price_per_query.as_yoctonear()) as u64,
                "paid_with": token,
            }),
        );
        let _ = ext_wrap::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_UNWRAP)
            .near_withdraw(amount);
        PromiseOrValue::Value(U128(0))
    }

    pub fn withdraw_credits(&mut self, amount: Option<U128>) -> Promise {
        let user = env::predecessor_account_id();
        let balance = self.prepaid.get(&user).copied().unwrap_or(0);
        let amount = amount.map(|a| a.0).unwrap_or(balance);
        require!(amount > 0 && amount <= balance, "Invalid withdrawal amount");
        self.prepaid.insert(user.clone(), balance - amount);
        emit(
            "credits_withdrawn",
            json!({ "user": user, "amount": U128(amount), "balance": U128(balance - amount) }),
        );
        Promise::new(user).transfer(NearToken::from_yoctonear(amount))
    }

    /// Operator only. Charge `queries` from a user's prepaid balance and split the fee:
    /// 70% contributors (by shares), 20% this operator, 10% treasury.
    pub fn charge(&mut self, user: AccountId, queries: u32) -> U128 {
        self.assert_not_paused();
        let op = env::predecessor_account_id();
        require!(
            self.operators.contains_key(&op),
            "Only registered operators can charge"
        );
        require!(queries > 0, "Queries must be positive");
        let fee = self.price_per_query.as_yoctonear() * queries as u128;
        let balance = self.prepaid.get(&user).copied().unwrap_or(0);
        require!(balance >= fee, "Insufficient credits");
        self.prepaid.insert(user.clone(), balance - fee);

        let contributor_part = fee * CONTRIBUTOR_BPS / BPS_DENOM;
        let operator_part = fee * OPERATOR_BPS / BPS_DENOM;
        let treasury_part = fee - contributor_part - operator_part;

        self.distribute_royalty(contributor_part);
        self.credit(&op, operator_part);
        self.treasury += treasury_part;
        self.total_queries += queries as u64;
        self.total_fees += fee;

        emit(
            "query_charged",
            json!({
                "user": user,
                "operator": op,
                "queries": queries,
                "fee": U128(fee),
                "contributors_share": U128(contributor_part),
                "operator_share": U128(operator_part),
                "treasury_share": U128(treasury_part),
                "balance": U128(balance - fee),
            }),
        );
        U128(balance - fee)
    }

    // ------------------------------------------------------------------
    // Earnings
    // ------------------------------------------------------------------

    /// Withdraw all claimable earnings (royalties, round rewards, operator fees).
    pub fn claim(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        self.settle(&account);
        let amount = self.pending.get(&account).copied().unwrap_or(0);
        require!(amount > 0, "Nothing to claim");
        self.pending.insert(account.clone(), 0);
        emit(
            "rewards_claimed",
            json!({ "account_id": account, "amount": U128(amount) }),
        );
        Promise::new(account.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CLAIM_CALLBACK)
                    .on_claim_complete(account, U128(amount)),
            )
    }

    /// Restores the claimable balance if the transfer failed.
    #[private]
    pub fn on_claim_complete(&mut self, account_id: AccountId, amount: U128) -> bool {
        // A transfer returns no data, so a 0-byte limit is enough to tell success from failure.
        match env::promise_result_checked(0, 0) {
            Ok(_) => true,
            Err(_) => {
                let p = self.pending.get(&account_id).copied().unwrap_or(0) + amount.0;
                self.pending.insert(account_id.clone(), p);
                emit(
                    "claim_refunded",
                    json!({ "account_id": account_id, "amount": amount }),
                );
                false
            }
        }
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// Before the first round, the evaluator may record the measured baseline of version 1.
    pub fn set_base_eval(&mut self, eval_loss_micros: u64, uri: Option<String>) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.evaluator || caller == self.owner,
            "Only evaluator or owner"
        );
        require!(
            self.rounds.is_empty(),
            "Base model is locked once the first round starts"
        );
        let v = self.model_versions.get_mut(0).unwrap();
        v.eval_loss_micros = eval_loss_micros;
        if let Some(u) = uri {
            require!(!u.is_empty() && u.len() <= MAX_URI_LEN, "Invalid model URI");
            v.uri = u;
        }
        emit(
            "base_eval_updated",
            json!({ "eval_loss_micros": eval_loss_micros, "uri": v.uri }),
        );
    }

    /// Set or clear the $HIVE token contract (this contract must be its minter).
    pub fn set_hive_token(&mut self, hive_token: Option<AccountId>) {
        self.assert_owner();
        self.hive_token = hive_token;
    }

    pub fn set_evaluator(&mut self, evaluator: AccountId) {
        self.assert_owner();
        self.evaluator = evaluator;
    }

    pub fn set_price_per_query(&mut self, price: NearToken) {
        self.assert_owner();
        require!(price.as_yoctonear() > 0, "Price must be positive");
        self.price_per_query = price;
    }

    pub fn set_min_stake(&mut self, min_stake: NearToken) {
        self.assert_owner();
        self.min_stake = min_stake;
    }

    pub fn set_operator_stake(&mut self, operator_stake: NearToken) {
        self.assert_owner();
        self.operator_stake = operator_stake;
    }

    pub fn set_max_submissions_per_round(&mut self, max: u32) {
        self.assert_owner();
        require!(max > 0, "Must allow at least one submission");
        self.max_submissions_per_round = max;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("paused_changed", json!({ "paused": paused }));
    }

    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.owner = new_owner;
    }

    pub fn withdraw_treasury(&mut self, amount: U128, receiver_id: Option<AccountId>) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0 && amount.0 <= self.treasury, "Invalid amount");
        self.treasury -= amount.0;
        let to = receiver_id.unwrap_or_else(|| self.owner.clone());
        emit(
            "treasury_withdrawn",
            json!({ "receiver_id": to, "amount": amount }),
        );
        Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
    }
}

// ----------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------
impl Hivemind {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
    }

    fn assert_evaluator(&self) {
        require!(
            env::predecessor_account_id() == self.evaluator,
            "Only evaluator"
        );
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "Contract is paused");
    }

    fn last_round(&self) -> Option<&Round> {
        let len = self.rounds.len();
        if len == 0 {
            None
        } else {
            self.rounds.get(len - 1)
        }
    }

    /// Index of the open (not finalized) round, or panic.
    fn open_round_index(&self) -> u32 {
        let len = self.rounds.len();
        require!(len > 0, "No round has been started");
        require!(
            !self.rounds.get(len - 1).unwrap().finalized,
            "No open round"
        );
        len - 1
    }

    fn contribution_index(&self, id: u32) -> u32 {
        require!(
            id >= 1 && id <= self.contributions.len(),
            "Unknown contribution"
        );
        id - 1
    }

    /// Royalties accrued by `account` that have not yet been moved into `pending`.
    pub(crate) fn unsettled(&self, account: &AccountId) -> u128 {
        let shares = self.shares.get(account).copied().unwrap_or(0);
        let debt = self.reward_debt.get(account).copied().unwrap_or(0);
        let accrued = shares * self.acc_reward_per_share / SCALE;
        accrued.saturating_sub(debt)
    }

    fn settle(&mut self, account: &AccountId) {
        let owed = self.unsettled(account);
        if owed > 0 {
            self.credit(account, owed);
        }
        let shares = self.shares.get(account).copied().unwrap_or(0);
        self.reward_debt
            .insert(account.clone(), shares * self.acc_reward_per_share / SCALE);
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        let p = self.pending.get(account).copied().unwrap_or(0) + amount;
        self.pending.insert(account.clone(), p);
        let l = self.lifetime_earned.get(account).copied().unwrap_or(0) + amount;
        self.lifetime_earned.insert(account.clone(), l);
    }

    fn add_shares(&mut self, account: &AccountId, amount: u128) {
        self.settle(account);
        let s = self.shares.get(account).copied().unwrap_or(0) + amount;
        self.shares.insert(account.clone(), s);
        self.total_shares += amount;
        self.reward_debt
            .insert(account.clone(), s * self.acc_reward_per_share / SCALE);
    }

    fn distribute_royalty(&mut self, amount: u128) {
        if amount == 0 {
            return;
        }
        if self.total_shares == 0 {
            self.treasury += amount;
            return;
        }
        let inc = amount * SCALE / self.total_shares;
        self.acc_reward_per_share += inc;
        // Rounding dust goes to the treasury.
        let distributed = inc * self.total_shares / SCALE;
        self.treasury += amount - distributed;
    }
}
