//! Read-only views used by the frontend, The Arena evaluator and the inference server.

use std::collections::HashMap;

use crate::*;

const DEFAULT_LIMIT: u32 = 50;

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub evaluator: AccountId,
    pub paused: bool,
    pub price_per_query: NearToken,
    pub min_stake: NearToken,
    pub operator_stake: NearToken,
    pub max_submissions_per_round: u32,
    pub contributor_bps: u32,
    pub operator_bps: u32,
    pub treasury_bps: u32,
    pub hive_token: Option<AccountId>,
    pub hive_per_score_micro: U128,
}

#[near(serializers = [json])]
pub struct Stats {
    pub latest_version: u32,
    pub latest_eval_loss_micros: u64,
    pub base_eval_loss_micros: u64,
    pub current_round: Option<u32>,
    pub round_open: bool,
    pub total_rounds: u32,
    pub total_contributions: u32,
    pub total_contributors: u32,
    pub total_shares: U128,
    pub total_operators: u32,
    pub treasury: U128,
    pub next_round_pool: U128,
    pub total_queries: U64,
    pub total_fees: U128,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub account_id: AccountId,
    pub shares: U128,
    /// Basis points of all royalty shares.
    pub share_bps: u32,
    pub claimable: U128,
    pub lifetime_earned: U128,
    pub prepaid: U128,
    pub queries_available: U64,
    pub is_operator: bool,
}

#[near(serializers = [json])]
pub struct LeaderboardEntry {
    pub account_id: AccountId,
    pub shares: U128,
    pub share_bps: u32,
    pub claimable: U128,
    pub lifetime_earned: U128,
    pub accepted_contributions: u32,
}

#[near(serializers = [json])]
pub struct OperatorView {
    pub account_id: AccountId,
    pub stake: NearToken,
    pub claimable: U128,
}

#[near]
impl Hivemind {
    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            evaluator: self.evaluator.clone(),
            paused: self.paused,
            price_per_query: self.price_per_query,
            min_stake: self.min_stake,
            operator_stake: self.operator_stake,
            max_submissions_per_round: self.max_submissions_per_round,
            contributor_bps: CONTRIBUTOR_BPS as u32,
            operator_bps: OPERATOR_BPS as u32,
            treasury_bps: (BPS_DENOM - CONTRIBUTOR_BPS - OPERATOR_BPS) as u32,
            hive_token: self.hive_token.clone(),
            hive_per_score_micro: U128(HIVE_PER_SCORE_MICRO),
        }
    }

    pub fn get_stats(&self) -> Stats {
        let latest = self
            .model_versions
            .get(self.model_versions.len() - 1)
            .unwrap();
        let base = self.model_versions.get(0).unwrap();
        let last = self.last_round();
        Stats {
            latest_version: latest.version,
            latest_eval_loss_micros: latest.eval_loss_micros,
            base_eval_loss_micros: base.eval_loss_micros,
            current_round: last.map(|r| r.id),
            round_open: last.map(|r| !r.finalized).unwrap_or(false),
            total_rounds: self.rounds.len(),
            total_contributions: self.contributions.len(),
            total_contributors: self.shares.len(),
            total_shares: U128(self.total_shares),
            total_operators: self.operators.len(),
            treasury: U128(self.treasury),
            next_round_pool: U128(self.next_round_pool),
            total_queries: U64(self.total_queries),
            total_fees: U128(self.total_fees),
        }
    }

    // ---- Rounds ----

    pub fn get_round(&self, round_id: u32) -> Option<Round> {
        if round_id == 0 {
            return None;
        }
        self.rounds.get(round_id - 1).cloned()
    }

    pub fn get_current_round(&self) -> Option<Round> {
        self.last_round().cloned()
    }

    pub fn get_rounds(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Round> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        (from..self.rounds.len())
            .take(limit as usize)
            .filter_map(|i| self.rounds.get(i).cloned())
            .collect()
    }

    // ---- Contributions ----

    pub fn get_contribution(&self, contribution_id: u32) -> Option<Contribution> {
        if contribution_id == 0 {
            return None;
        }
        self.contributions.get(contribution_id - 1).cloned()
    }

    pub fn get_contributions(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Contribution> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        (from..self.contributions.len())
            .take(limit as usize)
            .filter_map(|i| self.contributions.get(i).cloned())
            .collect()
    }

    pub fn get_round_contributions(&self, round_id: u32) -> Vec<Contribution> {
        self.get_round(round_id)
            .map(|r| {
                r.contribution_ids
                    .iter()
                    .filter_map(|id| self.contributions.get(id - 1).cloned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Contributions in the open round still waiting for The Arena.
    pub fn get_pending_contributions(&self) -> Vec<Contribution> {
        match self.last_round() {
            Some(r) if !r.finalized => r
                .contribution_ids
                .iter()
                .filter_map(|id| self.contributions.get(id - 1))
                .filter(|c| c.status == ContributionStatus::Pending)
                .cloned()
                .collect(),
            _ => vec![],
        }
    }

    // ---- Models ----

    pub fn get_model_versions(&self) -> Vec<ModelVersion> {
        self.model_versions.iter().cloned().collect()
    }

    pub fn get_latest_model(&self) -> ModelVersion {
        self.model_versions
            .get(self.model_versions.len() - 1)
            .cloned()
            .unwrap()
    }

    // ---- Accounts ----

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let shares = self.shares.get(&account_id).copied().unwrap_or(0);
        let prepaid = self.prepaid.get(&account_id).copied().unwrap_or(0);
        let unsettled = self.unsettled(&account_id);
        AccountView {
            shares: U128(shares),
            share_bps: self.share_bps(shares),
            claimable: U128(self.pending.get(&account_id).copied().unwrap_or(0) + unsettled),
            lifetime_earned: U128(
                self.lifetime_earned.get(&account_id).copied().unwrap_or(0) + unsettled,
            ),
            prepaid: U128(prepaid),
            queries_available: U64((prepaid / self.price_per_query.as_yoctonear()) as u64),
            is_operator: self.operators.contains_key(&account_id),
            account_id,
        }
    }

    pub fn get_credits(&self, account_id: AccountId) -> U128 {
        U128(self.prepaid.get(&account_id).copied().unwrap_or(0))
    }

    /// Contributors ranked by royalty shares.
    pub fn get_leaderboard(&self, limit: Option<u32>) -> Vec<LeaderboardEntry> {
        let mut accepted: HashMap<&AccountId, u32> = HashMap::new();
        for c in self.contributions.iter() {
            if matches!(
                c.status,
                ContributionStatus::Accepted | ContributionStatus::Merged
            ) {
                *accepted.entry(&c.contributor).or_default() += 1;
            }
        }
        let mut entries: Vec<LeaderboardEntry> = self
            .shares
            .iter()
            .map(|(acct, shares)| {
                let unsettled = self.unsettled(acct);
                LeaderboardEntry {
                    account_id: acct.clone(),
                    shares: U128(*shares),
                    share_bps: self.share_bps(*shares),
                    claimable: U128(self.pending.get(acct).copied().unwrap_or(0) + unsettled),
                    lifetime_earned: U128(
                        self.lifetime_earned.get(acct).copied().unwrap_or(0) + unsettled,
                    ),
                    accepted_contributions: accepted.get(acct).copied().unwrap_or(0),
                }
            })
            .collect();
        entries.sort_by_key(|e| std::cmp::Reverse(e.shares.0));
        entries.truncate(limit.unwrap_or(DEFAULT_LIMIT) as usize);
        entries
    }

    pub fn get_operators(&self) -> Vec<OperatorView> {
        self.operators
            .iter()
            .map(|(acct, stake)| OperatorView {
                account_id: acct.clone(),
                stake: *stake,
                claimable: U128(self.pending.get(acct).copied().unwrap_or(0)),
            })
            .collect()
    }
}

impl Hivemind {
    fn share_bps(&self, shares: u128) -> u32 {
        (shares * BPS_DENOM)
            .checked_div(self.total_shares)
            .unwrap_or(0) as u32
    }
}
